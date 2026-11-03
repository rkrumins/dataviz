"""Subset views: ``POST /views/from-search``, ``/views/{id}/search`` and
``/views/{id}/subsets``.

A subset view shows the matches of one search inside another view, its base
(``config.search``, the contract in ``backend/common/models/search_view.py``).
It stores no matches — the search engine reads them on every open
(``POST /{ws}/graph/search/view-feed``) — so making one costs no graph work at
all, whatever the search finds.

* ``POST /views/from-search`` — make one (``Idempotency-Key`` makes a retry
  answer with the first view).
* ``GET /views/{id}/search`` — its search, its base and the layers it shows
  (an ETag, so a poll costs a 304).
* ``PUT /views/{id}/search`` — change the search, or where its layers come from,
  against the definition hash it was read at; recorded as a version.
* ``GET /views/{id}/subsets`` — the subset views made from a view: what changing
  or deleting it reaches.

Authoring a search needs read access to the data source: it decides what every
reader of the view sees there, and a reader of a subset needs no access to its
base. Mounted at ``/views`` before ``views.router``, so no ``/{view_id}`` route
there can capture these.
"""
from __future__ import annotations

import hashlib
import json
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.view_membership import _view
from backend.app.api.v1.endpoints.views import _compute_ontology_digest, _user_id, authorize_view_create
from backend.app.api.v1.feature_gate import ensure_view_mode_allowed, require_feature
from backend.app.api.v1.view_read_scope import viewer_context
from backend.app.auth.dependencies import get_optional_user, get_permission_claims, rbac_flag
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM, view_is_live
from backend.app.db.repositories import view_activity_repo, view_repo, view_version_repo
from backend.app.db.repositories.view_membership_repo import now_iso
from backend.app.services import view_access
from backend.app.services.live_views.pipeline import config_of, effective_data_source
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.search_views import (
    SubsetError,
    check_predicate,
    is_subset,
    layers_of,
    layout_problems,
    own_layers,
    places_by_more_than_type,
    subset_layers,
)
from backend.app.services.view_scope import _collect_content_scope, _collect_reference_roots
from backend.common.models.management import ViewCreateRequest, ViewResponse
from backend.common.models.search_view import (
    REST_LAYER_ID,
    FromSearchRequest,
    SearchViewDefinition,
    SearchViewStatus,
    SearchViewUpdate,
    SubsetLayer,
    SubsetList,
    SubsetSummary,
    read_search_definition,
)
from backend.common.models.view_membership import ReadInView

router = APIRouter()

#: A preview: it ships off, and a flag that cannot be read means off.
require_search_views = require_feature("searchViewsEnabled", default=False)


class ViewWithSearch(BaseModel):
    """A subset view, and what it shows."""
    model_config = ConfigDict(populate_by_name=True)
    view: ViewResponse
    search: SearchViewStatus


def _refused(exc: SubsetError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


def _may_author(ctx: view_access.ViewerContext, workspace_id: str) -> bool:
    """A search decides what every reader of a subset sees across its data source —
    whoever writes one reads that source themselves."""
    return not ctx.is_anonymous and has_permission(
        ctx.claims, "workspace:datasource:read", workspace_id=workspace_id)


def _require_author(ctx: view_access.ViewerContext, workspace_id: str) -> None:
    if not _may_author(ctx, workspace_id):
        raise HTTPException(status_code=403, detail={
            "error": "missing_permission", "permission": "workspace:datasource:read",
            "message": "A subset view's search is written by someone who can read its data source."})


def _search_of(row: ViewORM) -> SearchViewDefinition:
    definition = read_search_definition(config_of(row))
    if definition is None:
        raise HTTPException(status_code=404, detail={"reason": "not_a_subset",
                                                     "message": "This view isn't a subset view."})
    return definition


async def _base_for(session: AsyncSession, ctx: view_access.ViewerContext, base_id: Optional[str], *,
                    workspace_id: str, data_source_id: Optional[str],
                    self_id: Optional[str] = None) -> ViewORM:
    """The base a subset is made from: a live view the caller can read, in the same
    workspace and data source, not the subset itself, and not a subset (a subset
    of a subset is its base's, with both searches — edit the search instead)."""
    if not base_id:
        raise HTTPException(status_code=422, detail="Name the view the subset is made from (readIn).")
    if base_id == self_id:
        raise HTTPException(status_code=422, detail="A view can't be a subset of itself.")
    base = (await session.execute(
        select(ViewORM).where(ViewORM.id == base_id, view_is_live()))).scalar_one_or_none()
    if base is None or (rbac_flag("RBAC_ENFORCE_VIEWS")
                        and not await view_access.can_read_view(session, ctx, base)):
        raise HTTPException(status_code=404, detail=f"View '{base_id}' not found")
    if base.workspace_id != workspace_id:
        raise HTTPException(status_code=422, detail="That view is in another workspace.")
    if is_subset(config_of(base)):
        raise HTTPException(status_code=422, detail=(
            "That view is a subset view already: narrow it further by editing its search, or make "
            "the subset from its base."))
    if await effective_data_source(session, base.workspace_id, base.data_source_id) != data_source_id:
        raise HTTPException(status_code=422, detail="That view shows a different data source.")
    return base


async def _live_base(session: AsyncSession, row: ViewORM,
                     definition: SearchViewDefinition) -> Optional[ViewORM]:
    """The subset's base as the system sees it — still there, and still its base —
    or None."""
    if definition.within != "view" or not definition.read_in:
        return None
    base = (await session.execute(
        select(ViewORM).where(ViewORM.id == definition.read_in, view_is_live()))).scalar_one_or_none()
    if (base is None or base.id == row.id or base.workspace_id != row.workspace_id
            or base.data_source_id != row.data_source_id or is_subset(config_of(base))):
        return None
    return base


def _unbounded(predicate, base_config: Optional[dict]) -> bool:
    """A search for a word alone where nothing bounds it: every entity of the data
    source would be read for it, on every open."""
    from backend.app.services.advanced_search_service import _is_unbounded_text_any
    if not _is_unbounded_text_any(predicate):
        return False
    if base_config is None:
        return True
    roots, types, _ = _collect_reference_roots(base_config)
    more_roots, more_types, _ = _collect_content_scope(base_config)
    return not (roots or more_roots or types or more_types)


async def search_status(session: AsyncSession, row: ViewORM, definition: SearchViewDefinition,
                        ctx: Optional[view_access.ViewerContext] = None) -> SearchViewStatus:
    """What a subset view shows. Its base's name is shown only to someone who can
    open the base."""
    base = await _live_base(session, row, definition)
    base_config = config_of(base) if base is not None else None
    view: Optional[ReadInView] = None
    if definition.within == "view":
        visible = base is not None and (ctx is None or not rbac_flag("RBAC_ENFORCE_VIEWS")
                                        or await view_access.can_read_view(session, ctx, base))
        view = ReadInView(view_id=definition.read_in, name=base.name if visible else None,
                          available=base is not None)
    missing = definition.within == "view" and base is None
    return SearchViewStatus(
        definition=definition,
        definition_hash=definition.definition_hash(),
        status="base_missing" if missing else "ok",
        base=view,
        layers=[] if missing else subset_layers(definition, config_of(row), base_config),
        placed_by_type=bool(definition.layout == "inherit" and base_config is not None
                            and places_by_more_than_type(base_config)),
    )


def _subset_config(definition: SearchViewDefinition, layers: List[dict], icon: Optional[str]) -> dict:
    """The new view's config, shaped as the wizard shapes one, so every screen treats
    it as any other view: a reference view of every entity of its layers' types (its
    search narrows that), its definition beside it."""
    return {
        "icon": icon or "Layout",
        "content": {"visibleEntityTypes": [], "visibleRelationshipTypes": [], "defaultDepth": 5,
                    "maxDepth": 10, "entityScope": "all"},
        "layout": {"type": "reference", "referenceLayout": {"layers": layers, "assignments": {}},
                   "lod": {"enabled": False, "levels": []}},
        "filters": {"entityTypeFilters": [], "fieldFilters": [], "searchableFields": [], "quickFilters": []},
        "entityOverrides": {},
        "search": definition.model_dump(mode="json", by_alias=True, exclude_none=True),
    }


def _layers_from_request(body: FromSearchRequest) -> List[dict]:
    """An own layout's layers, as the request names them, with the rest last."""
    layers = [SubsetLayer(id=f"layer-{i + 1}", name=l.name, color=l.color,
                          entity_types=list(dict.fromkeys(l.entity_types)))
              for i, l in enumerate(body.layers or [])]
    if body.rest:
        layers.append(SubsetLayer(id=REST_LAYER_ID, name=body.rest, rest=True))
    return own_layers(layers)


async def _replayed(session: AsyncSession, request_id: str, actor: str) -> Optional[ViewWithSearch]:
    """What a previous attempt of this request made, if it made anything. A request
    id is the client's: someone else's — or one used for something else — is a 409."""
    version = await view_version_repo.find_by_request_id(session, request_id)
    if version is None:
        return None
    row = (await session.execute(select(ViewORM).where(ViewORM.id == version.view_id, view_is_live()))
           ).scalar_one_or_none()
    if version.source != "create" or version.created_by != actor or row is None or not is_subset(config_of(row)):
        raise HTTPException(status_code=409, detail={
            "type": "request_id_taken", "message": "This request id was already used. Try again."})
    view = await view_repo.get_view_enriched(session, row.id, user_id=actor)
    return ViewWithSearch(view=view, search=await search_status(session, row, _search_of(row)))


# ── Make a subset view ───────────────────────────────────────────────────────

@router.post(
    "/from-search", response_model=ViewWithSearch, response_model_by_alias=True, status_code=201,
    dependencies=[Depends(require_search_views)],
)
async def create_view_from_search(
    response: Response,
    body: FromSearchRequest = Body(...),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key", max_length=128),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewWithSearch:
    """Make a view of a search's matches.

    ``within`` ``view`` (the default): the matches inside ``readIn``, the view the
    search was run in — the subset's base; ``dataSource``: anywhere in the data
    source. ``layout`` ``inherit`` (the default for a subset of a view): its layers
    are its base's, read live and placed by type, plus "Other matches"; ``own``:
    ``layers`` of types, and ``rest`` for every other match.

    Nothing about the matches is worked out here, so a subset is made at once,
    however many there are. ``Idempotency-Key`` makes a retry safe: the same caller
    sending the same key gets the view the first attempt made (200).
    """
    actor = _user_id(user)
    request_id = f"fs:{actor}:{idempotency_key}" if idempotency_key else None
    if request_id:
        replayed = await _replayed(session, request_id, actor)
        if replayed is not None:
            response.status_code = 200
            return replayed
    try:
        predicate = check_predicate(body.model_dump(mode="json", by_alias=True)["predicate"])
    except SubsetError as exc:
        raise _refused(exc) from exc

    await authorize_view_create(claims, session, workspace_id=body.workspace_id,
                                data_source_id=body.data_source_id, visibility=body.visibility)
    await ensure_view_mode_allowed("reference", session)
    ctx = await viewer_context(session, user, claims)
    _require_author(ctx, body.workspace_id)
    ds = await effective_data_source(session, body.workspace_id, body.data_source_id)
    base = (await _base_for(session, ctx, body.read_in, workspace_id=body.workspace_id, data_source_id=ds)
            if body.within == "view" else None)
    if _unbounded(predicate, config_of(base) if base is not None else None):
        raise HTTPException(status_code=422, detail=(
            "A word on its own would have to be looked for in every entity of the data source, on "
            "every open. Add a type, tag or property to the search."))

    definition = SearchViewDefinition(
        predicate=predicate, within=body.within, read_in=base.id if base is not None else None,
        layout=body.layout,
        provenance=body.provenance.model_copy(update={"created_at": now_iso(), "created_by": actor}),
    )
    config = _subset_config(definition, _layers_from_request(body) if body.layout == "own" else [],
                            body.icon)
    problem = layout_problems(config)
    if problem:
        raise HTTPException(status_code=422, detail=problem)

    view = await view_repo.create_view(session, ViewCreateRequest(
        name=body.name, description=body.description, workspace_id=body.workspace_id,
        data_source_id=base.data_source_id if base is not None else body.data_source_id,
        view_type="reference", config=config, visibility=body.visibility, tags=body.tags,
    ), ontology_digest=await _compute_ontology_digest(session, body.workspace_id, body.data_source_id),
        user_id=actor)
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view.id))).scalar_one()
    row.subset_of = base.id if base is not None else None
    version, created = await view_version_repo.checkpoint(
        session, row, source="create", actor=actor, request_id=request_id,
        provenance={"madeFrom": definition.provenance.model_dump(by_alias=True, exclude_none=True)},
    )
    if not created and version.view_id != row.id:
        # The same request, sent twice at once: the other copy made the view.
        await session.rollback()
        response.status_code = 200
        replayed = await _replayed(session, request_id, actor) if request_id else None
        if replayed is None:
            raise HTTPException(status_code=409, detail="This view was just made by another request.")
        return replayed
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="created", actor=actor,
        summary=f'Created "{row.name}" from a search',
    )
    await session.flush()
    return ViewWithSearch(view=await view_repo.get_view_enriched(session, row.id, user_id=actor),
                          search=await search_status(session, row, definition, ctx))


# ── What it shows ────────────────────────────────────────────────────────────

@router.get(
    "/{view_id}/search", response_model=SearchViewStatus, response_model_by_alias=True,
    dependencies=[Depends(require_search_views)],
)
async def get_view_search(
    request: Request,
    response: Response,
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """A subset view's search, where its matches are looked for (its base, named
    only to someone who can open it, and whether it is still there) and the layers
    they are shown in. Answers 304 to an ``If-None-Match`` that still holds."""
    row, ctx = await _view(session, view_id, user, claims, edit=False)
    status = await search_status(session, row, _search_of(row), ctx)
    body = status.model_dump(mode="json", by_alias=True)
    etag = 'W/"' + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:32] + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return status


# ── Change it ────────────────────────────────────────────────────────────────

@router.put(
    "/{view_id}/search", response_model=SearchViewStatus, response_model_by_alias=True,
    dependencies=[Depends(require_search_views)],
)
async def update_view_search(
    view_id: str = Path(...),
    body: SearchViewUpdate = Body(...),
    branch_id: Optional[str] = Query(None, alias="branchId"),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Change a subset view's search, or where its layers come from: ``layout``
    ``own`` gives it its base's layers as they are now, to change as its own;
    ``inherit`` drops them, and it follows its base again. Sent with the
    ``definitionHash`` it was read at: a 409 answers a stale one with the current
    definition. Recorded as a version of the view; made on the published view."""
    if branch_id:
        raise HTTPException(status_code=409, detail=(
            "A subset view's search is changed on the published view, not in a draft."))
    actor = _user_id(user)
    row, ctx = await _view(session, view_id, user, claims, edit=True, lock=True)
    definition = _search_of(row)
    _require_author(ctx, row.workspace_id)
    if body.if_definition_hash != definition.definition_hash():
        raise HTTPException(status_code=409, detail={
            "reason": "changed", "message": "Someone changed this view's search. Review it and try again.",
            "definition": definition.model_dump(mode="json", by_alias=True, exclude_none=True),
            "definitionHash": definition.definition_hash(),
        })
    config = config_of(row)
    updated = definition
    summary: List[str] = []
    if body.predicate is not None:
        try:
            predicate = check_predicate(body.model_dump(mode="json", by_alias=True)["predicate"])
        except SubsetError as exc:
            raise _refused(exc) from exc
        base = await _live_base(session, row, definition)
        if _unbounded(predicate, config_of(base) if base is not None else None):
            raise HTTPException(status_code=422, detail=(
                "A word on its own would have to be looked for in every entity of the data source. "
                "Add a type, tag or property to the search."))
        if predicate != definition.predicate:
            updated = updated.model_copy(update={"predicate": predicate})
            summary.append("Changed its search")
    if body.layout is not None and body.layout != definition.layout:
        ref = config.setdefault("layout", {})
        if body.layout == "own":
            base = await _live_base(session, row, definition)
            if base is None:
                raise HTTPException(status_code=409, detail={
                    "reason": "base_missing",
                    "message": "Its base view is no longer available, so there are no layers to copy."})
            ref["referenceLayout"] = {"layers": own_layers(layers_of(config_of(base), add_rest=True)),
                                      "assignments": {}}
            summary.append("Gave it a layout of its own")
        else:
            if definition.within != "view":
                raise HTTPException(status_code=422, detail=(
                    "Only a subset of a view can follow that view's layers."))
            ref["referenceLayout"] = {"layers": [], "assignments": {}}
            summary.append("Follows its base view's layers again")
        config.pop("referenceLayout", None)
        updated = updated.model_copy(update={"layout": body.layout})
    if updated == definition:
        return await search_status(session, row, definition, ctx)

    config["search"] = updated.model_dump(mode="json", by_alias=True, exclude_none=True)
    row.config = json.dumps(config)
    row.updated_by = actor
    await view_version_repo.checkpoint(session, row, source="wizard", actor=actor,
                                       message="; ".join(summary))
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="updated", actor=actor,
        summary="; ".join(summary), changes={"search": sorted(
            k for k in ("predicate", "layout") if getattr(body, k) is not None)},
    )
    await session.commit()
    row, ctx = await _view(session, view_id, user, claims, edit=False)
    return await search_status(session, row, _search_of(row), ctx)


# ── The subsets of a view ────────────────────────────────────────────────────

@router.get(
    "/{view_id}/subsets", response_model=SubsetList, response_model_by_alias=True,
    dependencies=[Depends(require_search_views)],
)
async def list_view_subsets(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> SubsetList:
    """The subset views made from this view: ``count`` counts every one — what a
    change to its layers, or its deletion, reaches — and ``items`` lists those the
    caller can open."""
    _row, ctx = await _view(session, view_id, user, claims, edit=False)
    rows = (await session.execute(
        select(ViewORM).where(ViewORM.subset_of == view_id, view_is_live()).order_by(ViewORM.name)
    )).scalars().all()
    items: List[SubsetSummary] = []
    for other in rows:
        if rbac_flag("RBAC_ENFORCE_VIEWS") and not await view_access.can_read_view(session, ctx, other):
            continue
        definition = read_search_definition(config_of(other))
        items.append(SubsetSummary(view_id=other.id, name=other.name,
                                   layout=definition.layout if definition else "own",
                                   visibility=other.visibility or "private", updated_at=other.updated_at))
    return SubsetList(count=len(rows), items=items)
