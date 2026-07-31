"""
View endpoints (top-level, cross-workspace).

Views are visual renderings of context models (or ad-hoc graphs).
Mounted at /api/v1/views

Access is decided by ``backend.app.services.view_access``: the view's
visibility tier says who it reaches, and explicit ``resource_grants``
extend that to named subjects. Mutations (create / edit / delete /
change-visibility / restore / hard-delete) check the corresponding
action predicate.

Every listing route resolves a ``ViewReadScope`` and hands it to the
repo, which turns it into a SQL predicate. Reads are therefore filtered
**in the query**, so ``total``/``hasMore`` describe the same authorized
population the rows come from. The previous design filtered items in
Python after the query, which made the counts over-report by exactly the
number of views the caller could not see, broke pagination, and left
every repo consumer that wasn't this endpoint unfiltered by default.

The ``RBAC_ENFORCE_VIEWS`` kill-switch no longer covers reads. It was a
single env var that disabled read, edit, delete, hard-delete, restore and
visibility-change together, and its purpose was to fall back to the
pre-enforcement behaviour. There is no such behaviour left to fall back
to now that authorization is the query itself — an unscoped read is not a
legacy mode, it is a full table dump. It still guards the mutation checks.
"""
import logging
import os
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
from backend.app.db.repositories import view_repo
from backend.app.db.repositories import view_activity_repo
from backend.app.db.repositories import binding_repo, grant_repo, user_repo
from backend.app.providers.manager import provider_manager as provider_registry  # alias during migration
from backend.app.services.context_engine import ContextEngine
from backend.app.services.permission_service import PermissionClaims
from backend.app.services import view_access
from backend.app.services.versioning.db import graphver_session
from backend.app.services.versioning.models import BranchORM
from backend.auth_service.interface import User
from backend.common.view_visibility import (
    DEFAULT_VISIBILITY,
    VISIBILITY_VALUES,
    ViewVisibility,
    is_valid_visibility,
)
from backend.common.models.management import (
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


async def _read_scope(
    session: AsyncSession,
    ctx: view_access.ViewerContext,
) -> view_access.ViewReadScope:
    """The caller's read reach, or 503 if it cannot be established.

    Every listing route goes through here rather than calling
    ``build_read_scope`` directly, because the failure it guards against
    is silent. Per-workspace grants live in the session store now; when it
    and the database fallback both fail, ``ws_perms`` is empty but means
    "unknown", and the SQL predicate built from it would return a **short
    list with a 200** — an ordinary-looking page missing rows the caller
    is entitled to. Refusing to answer is the only honest option.

    503 with this wording because that is what ``requires()`` answers for
    the same situation, and the SPA should see one behaviour whichever
    gate refused.
    """
    scope = await view_access.build_read_scope(session, ctx)
    if scope.indeterminate:
        logger.warning(
            "Cannot establish workspace grants for user=%s; answering 503 "
            "rather than a filtered view list", ctx.user_id or "<anonymous>",
        )
        raise HTTPException(
            status_code=503, detail="Authorization temporarily unavailable",
        )
    return scope


async def _load_view_orm(session: AsyncSession, view_id: str) -> ViewORM:
    """Fetch the raw ORM row (the access predicates need it).

    The endpoint then calls ``view_repo.get_view_enriched`` to return
    the response shape — kept separate so the access check happens
    against the authoritative row and not a lossy DTO projection.
    """
    from sqlalchemy import select
    row = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    view = row.scalar_one_or_none()
    if view is None:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


class _ViewProxy:
    """Adapter that exposes the access-predicate fields off a
    ``ViewResponse``-shaped object.

    List responses are DTOs from the repo, not ORM rows. The reason
    evaluator only needs ``id``, ``workspace_id``, ``visibility``, and
    ``created_by`` — all present on the response shape — so we wrap the
    DTO rather than re-fetching every row just to explain it.
    """

    __slots__ = ("id", "workspace_id", "visibility", "created_by")

    def __init__(self, *, id, workspace_id, visibility, created_by):
        self.id = id
        self.workspace_id = workspace_id
        self.visibility = visibility
        self.created_by = created_by

    @classmethod
    def from_response(cls, item) -> "_ViewProxy":
        # Pydantic models expose snake-case attrs; legacy ORM responses
        # via ``from_attributes`` do too. Both paths funnel here.
        return cls(
            id=getattr(item, "id"),
            workspace_id=getattr(item, "workspace_id", None),
            visibility=getattr(item, "visibility", DEFAULT_VISIBILITY),
            created_by=getattr(item, "created_by", None),
        )


async def _record_visibility_change(
    session: AsyncSession,
    *,
    view_id: str,
    view_name: Optional[str],
    workspace_id: str,
    before: Optional[str],
    after: str,
    actor: str,
) -> None:
    """Record a tier change on both trails.

    ``view_activity_log`` is the per-view product timeline users read.
    The outbox event is the *security* trail — it lands in
    ``auth_audit_log`` alongside role changes and binding revocations,
    which is where an ``org_auditor`` looks. Until this existed, promoting
    a view to ``enterprise`` or ``public`` — the one action that can expose
    a workspace's data platform-wide — was the only access-widening
    mutation on the platform with no security-trail entry.

    Widening is a ``warning``; narrowing is ``info``. See
    ``endpoints/audit.py: _EVENT_META``.
    """
    if before == after:
        return
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=workspace_id,
        action="visibility_changed", actor=actor,
        summary=f"Visibility {before} → {after}",
        changes={"visibility": {"from": before, "to": after}},
    )
    order = VISIBILITY_VALUES
    try:
        widened = order.index(after) > order.index(before or DEFAULT_VISIBILITY)
    except ValueError:
        # An unrecognised tier on either side — treat as widening so the
        # event is never quietly downgraded to info.
        widened = True
    event = (
        "rbac.view.visibility_widened" if widened
        else "rbac.view.visibility_narrowed"
    )
    try:
        await user_repo.create_outbox_event(
            session,
            event_type=event,
            payload={
                "view_id": view_id,
                "view_name": view_name,
                "workspace_id": workspace_id,
                "from": before,
                "to": after,
                "actor_id": actor,
            },
        )
    except Exception:  # pragma: no cover - audit must never block the write
        logger.warning(
            "Failed to emit %s for view %s", event, view_id, exc_info=True,
        )


async def _stamp_granted_by(
    session: AsyncSession,
    ctx: view_access.ViewerContext,
    *item_lists: Optional[List[ViewResponse]],
) -> None:
    """Annotate each response with *why* the caller can see it.

    The rows are already authorized — the SQL predicate did that — so this
    only explains the outcome. Reasons are computed for the whole batch at
    once so the ``resource_grants`` lookup runs once, not once per view.
    """
    items = [i for lst in item_lists if lst for i in lst]
    if not items:
        return
    proxies = [_ViewProxy.from_response(i) for i in items]
    reasons = await view_access.annotate_read_reasons(session, ctx, proxies)
    for item in items:
        item.granted_by = reasons.get(item.id)


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
    if req.visibility is not None and req.visibility != old.visibility:
        ch["visibility"] = {"from": old.visibility, "to": req.visibility}
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


@router.get("/popular", response_model=List[ViewResponse])
async def list_popular_views(
    limit: int = Query(20, le=100),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """List the most-favourited views the caller can read.

    Single-flight wrapped: when N concurrent callers hit this with the
    same (principal, limit) pair the leader runs the query and the
    others receive the same result. Most-favourited views are a
    homepage-style render that frequently sees burst traffic from
    every Explorer tab opening at once; this kills the thundering
    herd against the views + favourites tables.

    The single-flight key includes the principal, so two callers with
    different reach never share a cached result.
    """
    ctx = await _viewer_context(session, user, claims)
    scope = await _read_scope(session, ctx)
    principal = normalised_principal(_user_id(user))
    key = ("popular", principal, limit)
    items = await read_views_sf.run(
        key,
        lambda: view_repo.list_popular_views(
            session, scope=scope, limit=limit, user_id=_user_id(user),
        ),
    )
    await _stamp_granted_by(session, ctx, items)
    return items


@router.get("/facets", response_model=ViewFacetsResponse)
async def get_view_facets(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewFacetsResponse:
    """Return distinct tags, view types, and creators across readable views.

    Used to populate the Explorer's Tag / View Type / Creator filter
    dropdowns from the authoritative DB-wide set of values rather than
    deriving them from the currently-loaded page (which would miss
    tags/creators beyond the first page at scale).

    Scoped to the caller: the creator facet carries display names and
    email addresses and the tag facet spans view metadata, so an unscoped
    version is a directory dump. It was unauthenticated and unscoped until
    this was fixed.

    Single-flight wrapped, keyed by principal — the result is per-caller
    now, so a shared key would serve one user's facets to another.
    """
    ctx = await _viewer_context(session, user, claims)
    scope = await _read_scope(session, ctx)
    return await read_views_sf.run(
        ("facets", normalised_principal(_user_id(user))),
        lambda: view_repo.get_view_facets(session, scope=scope),
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
    shared_with_me: bool = Query(
        False,
        alias="sharedWithMe",
        description=(
            "Only views explicitly shared with the caller via resource_grants "
            "(directly or through a group). Distinct from a visibility filter: "
            "a team-wide view nobody shared is not 'shared with me'."
        ),
    ),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    deleted_only: bool = Query(False, alias="deletedOnly"),
    attention_only: bool = Query(False, alias="attentionOnly"),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewCatalogStats:
    """Aggregate counts for the Explorer stats bar, scoped to the same
    filters the list endpoint accepts. All four numbers describe the
    currently-filtered population so the stats bar stays in sync as
    users narrow their query.

    Authentication is required. The filter params are unrestricted, so an
    anonymous caller could otherwise use the counts as an oracle over
    private view names, descriptions and tags (``search`` spans all of
    them) by probing ``?visibility=private&createdBy=<victim>``.
    """
    ctx = await _viewer_context(session, user, claims)
    scope = await _read_scope(session, ctx)
    return await view_repo.get_view_stats(
        session,
        scope=scope,
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
        created_after=created_after,
        search=search,
        tags=tags,
        user_id=_user_id(user),
        favourited_only=favourited_only,
        shared_with_me=shared_with_me,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
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
    shared_with_me: bool = Query(
        False,
        alias="sharedWithMe",
        description=(
            "Only views explicitly shared with the caller via resource_grants "
            "(directly or through a group). Distinct from a visibility filter: "
            "a team-wide view nobody shared is not 'shared with me'."
        ),
    ),
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
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewListResponse:
    """List accessible views as a paginated envelope.

    Returns ``{ items, total, hasMore, nextOffset }``. ``total`` is the
    authoritative count of matches so callers never have to infer "is
    there another page?" from array length.

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
    """
    ctx = await _viewer_context(session, user, claims)
    scope = await _read_scope(session, ctx)
    response = await view_repo.list_views_filtered(
        session,
        scope=scope,
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
        created_after=created_after,
        search=search,
        tags=tags,
        sort=sort,
        limit=limit,
        offset=offset,
        user_id=_user_id(user),
        favourited_only=favourited_only,
        shared_with_me=shared_with_me,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
    )

    # Optional ?include=popular: fold the trending strip into the same
    # response so the Explorer only makes one round-trip instead of two.
    # It goes through the same read scope as everything else.
    if "popular" in include:
        response.popular = await view_repo.list_popular_views(
            session, scope=scope, limit=popular_limit, user_id=_user_id(user),
        )

    await _stamp_granted_by(session, ctx, response.items, response.popular)
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
    workspace. Phase 2C enforces; Phase 1 left this open.
    """
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        from backend.app.services.permission_service import has_permission
        if not has_permission(
            claims, "workspace:view:create", workspace_id=req.workspace_id,
        ):
            raise HTTPException(
                status_code=403,
                detail="Missing permission: workspace:view:create",
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
    and other branches see the base. Absent (or no overlay) → base, unchanged."""
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if not await view_access.can_read_view(session, ctx, view_orm):
        # 404 (not 403) so view existence stays private from
        # users with no access path.
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    view = await view_repo.get_view_enriched(
        session, view_id, user_id=_user_id(user), branch_id=branch_id,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
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
        # Changing the tier through the general update route requires the
        # SAME authority as the dedicated visibility route. Without this,
        # ``workspace:view:edit`` (a standard member) could widen any view
        # they can edit by sending ``visibility`` in the body — a bypass of
        # the creator-or-workspace-admin rule the other endpoint enforces.
        new_visibility = getattr(req.visibility, "value", req.visibility)
        if (
            new_visibility is not None
            and new_visibility != existing.visibility
            and not view_access.can_change_visibility(ctx, view_orm)
        ):
            raise HTTPException(
                status_code=403,
                detail="Only the creator or a workspace admin can change visibility",
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
    if view.visibility != existing.visibility:
        await _record_visibility_change(
            session,
            view_id=view.id, view_name=view.name,
            workspace_id=view.workspace_id,
            before=existing.visibility, after=view.visibility,
            actor=_user_id(user),
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
        view_orm = await _load_view_orm(session, view_id)
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
        if deleted:
            # ``resource_grants.resource_id`` has no FK to ``views.id`` (the
            # table is polymorphic), so nothing cascades on its own. Left
            # behind, the rows outlive the view they describe and would
            # silently re-confer access if the id were ever reused or the
            # view restored from a backup.
            await grant_repo.delete_resource_grants(
                session, resource_type="view", resource_id=view_id,
            )
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
        view_orm = await _load_view_orm(session, view_id)
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
    """Change the visibility of a view (private | workspace | enterprise | public).

    Creator or workspace admin only — see the action matrix.
    """
    if not is_valid_visibility(visibility):
        raise HTTPException(
            status_code=422,
            detail=f"visibility must be one of: {', '.join(VISIBILITY_VALUES)}",
        )

    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        view_orm = await _load_view_orm(session, view_id)
        ctx = await _viewer_context(session, user, claims)
        if not view_access.can_change_visibility(ctx, view_orm):
            raise HTTPException(
                status_code=403,
                detail="Only the creator or a workspace admin can change visibility",
            )

    existing = await view_repo.get_view(session, view_id)
    view = await view_repo.update_visibility(
        session, view_id, visibility, user_id=_user_id(user),
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    if existing:
        await _record_visibility_change(
            session,
            view_id=view_id, view_name=view.name,
            workspace_id=view.workspace_id,
            before=existing.visibility, after=visibility,
            actor=_user_id(user),
        )
    return view


class VisibilityPreviewResponse(BaseModel):
    """Who would gain access if this view moved to ``tier``."""
    model_config = ConfigDict(populate_by_name=True)
    tier: str
    #: How many principals reach the view at this tier but not at its
    #: current one. ``None`` for tiers whose audience is unbounded.
    added_count: Optional[int] = Field(None, alias="addedCount")
    #: A few of them, for the "…and 42 others" line.
    sample: List[str] = Field(default_factory=list)
    #: Plain-English audience, for when a count is meaningless.
    reach: str = ""
    widening: bool = False


@router.get(
    "/{view_id}/visibility-preview",
    response_model=VisibilityPreviewResponse,
    response_model_by_alias=True,
)
async def preview_visibility(
    view_id: str = Path(...),
    tier: str = Query(..., description="The tier being considered."),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> VisibilityPreviewResponse:
    """Answer "who will be able to see this?" *before* the tier is applied.

    Promotion is a one-click action whose blast radius is otherwise
    invisible, which is how views end up over-shared: the person choosing
    "Enterprise" has no way to know whether that means nine colleagues or
    nine hundred. This is the read predicate inverted — given a view and a
    target tier, who reaches it there who does not reach it now.

    Counting stops at the workspace tier. ``enterprise`` and ``public``
    are answered with prose rather than a number: both are unbounded
    audiences, and a precise headcount of everyone in the organisation is
    both expensive and, for a caller who may not administer those
    workspaces, a directory disclosure in its own right.
    """
    if not is_valid_visibility(tier):
        raise HTTPException(
            status_code=422,
            detail=f"tier must be one of: {', '.join(VISIBILITY_VALUES)}",
        )

    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if not await view_access.can_read_view(session, ctx, view_orm):
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    current = view_orm.visibility or DEFAULT_VISIBILITY
    order = VISIBILITY_VALUES
    widening = order.index(tier) > order.index(current) if is_valid_visibility(current) else True

    if tier in (ViewVisibility.PRIVATE.value, ViewVisibility.WORKSPACE.value):
        bindings = await binding_repo.list_for_scope(
            session, scope_type="workspace", scope_id=view_orm.workspace_id,
        )
        subjects = {(b.subject_type, b.subject_id) for b in bindings}
        user_ids = [sid for kind, sid in subjects if kind == "user"]
        names = await view_repo.resolve_user_ids(session, set(user_ids))
        labels = sorted(
            names.get(uid, (uid, None))[0] or uid for uid in user_ids
        )
        group_count = sum(1 for kind, _ in subjects if kind == "group")
        if tier == ViewVisibility.PRIVATE.value:
            # Only the creator and admins of the workspace.
            return VisibilityPreviewResponse(
                tier=tier, added_count=0, sample=[],
                reach="you, anyone you share it with, and this workspace's admins",
                widening=widening,
            )
        return VisibilityPreviewResponse(
            tier=tier,
            added_count=len(labels) + group_count,
            sample=labels[:5],
            reach=f"everyone with access to {view_orm.workspace_id}",
            widening=widening,
        )

    reach = (
        "everyone in the organisation — including people who are not in "
        "this workspace"
        if tier == ViewVisibility.ENTERPRISE.value
        else "every signed-in account on the platform, including people "
             "with no workspace access at all"
    )
    return VisibilityPreviewResponse(
        tier=tier, added_count=None, sample=[], reach=reach, widening=widening,
    )


@router.post("/{view_id}/favourite", status_code=201)
async def favourite_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Favourite a view for the current user.

    Gated on read access, like ``/{view_id}/visit``. Without the gate the
    404-vs-201 split is an existence oracle for arbitrary view ids, and a
    caller who cannot read the view can still write ``favourited`` rows
    into its owner's activity timeline and inflate its ranking in the
    trending strip.
    """
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if not await view_access.can_read_view(session, ctx, view_orm):
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    view = await view_repo.get_view(session, view_id)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    created = await view_repo.favourite_view(session, view_id, _user_id(user))
    if created:
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=view.workspace_id,
            action="favourited", actor=_user_id(user), summary="Favourited",
        )
    return {"favourited": True, "created": created}


@router.delete("/{view_id}/favourite", status_code=204)
async def unfavourite_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove favourite for the current user. Gated on read access — see
    ``favourite_view`` for why."""
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if not await view_access.can_read_view(session, ctx, view_orm):
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
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

    Over-fetch, then apply the SAME per-view read predicate as the views list
    (``can_read_view``), then trim — so the feed can never surface activity for a
    view the user has no access to.
    """
    pairs = await view_activity_repo.get_recent_activity(session, limit=limit * 4)

    ctx = await _viewer_context(session, user, claims)
    visible: List[view_activity_repo.ViewActivityEntry] = []
    for entry, view_orm in pairs:
        if len(visible) >= limit:
            break
        if await view_access.can_read_view(session, ctx, view_orm):
            visible.append(entry)
    return visible


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
    out: List[MyDraftEntry] = []
    for d in drafts:
        if len(out) >= limit:
            break
        view = by_id.get(d.originating_view_id)
        if view is None:
            continue  # view deleted since the draft was opened
        if not await view_access.can_read_view(session, ctx, view):
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
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The signed-in user's recently visited views — "Continue where you left off".

    Server-side and per-user, so it follows them across devices/browsers and is
    joined against the LIVE views (never a stale name, deleted views drop out).
    Access is re-checked on read, so a view that was unshared or narrowed
    after the visit drops out too.
    """
    ctx = await _viewer_context(session, user, claims)
    scope = await _read_scope(session, ctx)
    return await view_repo.list_recent_views(
        session, _user_id(user), scope=scope, limit=limit,
    )


@router.post("/{view_id}/visit", status_code=204)
async def record_visit(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Record that the current user opened this view (drives the recents strip)."""
    view_orm = await _load_view_orm(session, view_id)
    ctx = await _viewer_context(session, user, claims)
    if not await view_access.can_read_view(session, ctx, view_orm):
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    await view_repo.record_view_visit(session, view_id, _user_id(user))
