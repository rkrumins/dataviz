"""``POST /views/{view_id}/duplicate``: a proper copy of a view, made the way its kind is made.

* **An ordinary view** — a new view with the same design: its layers and what people placed
  in them, its display rules, its styles and filters — checked as ``POST /views`` checks one.
* **A view made from a query** (``config.membership``) — made through ``POST /views/from-members``'
  own steps (``view_membership.make_list_view``): the same definition, layout and mode, its
  layers and entries as they are, its members worked out afresh. It answers as that route
  does: 201 with how keeping it is going (maybe still ``updating``), or 202 while what its
  sources reach is still being worked out — nothing is made then: send it again, with the same
  ``Idempotency-Key``, to carry on.
* **A subset view** (``config.search``) — made through ``POST /views/from-search``, with the
  same search, base, layout and what it keeps beside its matches.

Each copy takes the view's saved queries too. Duplicating needs read access to the view (404
otherwise, so a view's existence stays private) and whatever making a view of its kind needs
where the copy goes. Mounted at ``/views`` before ``views.router``, so no ``/{view_id}`` route
there can capture it.
"""
from __future__ import annotations

import copy
import json
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, Header, Path, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.search_views import create_view_from_search, require_search_views
from backend.app.api.v1.endpoints.view_membership import (
    ListViewCopy,
    _view,
    get_engine_scope,
    make_list_view,
    require_membership,
)
from backend.app.api.v1.endpoints.views import (
    _compute_ontology_digest,
    _template_version,
    _user_id,
    authorize_view_create,
)
from backend.app.api.v1.feature_gate import ensure_view_mode_allowed
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.auth.dependencies import get_optional_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM, ViewSavedQueryORM
from backend.app.db.repositories import view_activity_repo, view_repo
from backend.app.services import template_access, view_library
from backend.app.services.live_views.pipeline import EngineScope, config_of, effective_data_source
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.search_views import is_subset, layers_of
from backend.common.models.management import ViewCreateRequest, ViewResponse
from backend.common.models.search_view import (
    FromSearchRequest,
    SearchLayer,
    SearchViewStatus,
    read_search_definition,
)
from backend.common.models.view_membership import FromMembersRequest, MembershipStatus, read_definition

router = APIRouter()

#: The longest name a view of any kind is made with (``FromMembersRequest``, ``FromSearchRequest``).
NAME_MAX = 200
DESCRIPTION_MAX = 2000


class DuplicateRequest(BaseModel):
    """What the copy is called, who sees it, and where it goes — each optional."""
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: Optional[str] = Field(None, min_length=1, max_length=120,
                                description='Default: "Copy of <the view\'s name>".')
    visibility: Literal["private", "workspace"] = "private"
    workspace_id: Optional[str] = Field(None, alias="workspaceId", max_length=128,
                                        description="Default: the view's own workspace.")


class DuplicatedView(BaseModel):
    """The copy; with how keeping it is going, for a view made from a query (``membership``),
    or what it shows, for a subset view (``search``)."""
    model_config = ConfigDict(populate_by_name=True)
    view: ViewResponse
    membership: Optional[MembershipStatus] = None
    search: Optional[SearchViewStatus] = None


@router.post(
    "/{view_id}/duplicate", response_model=DuplicatedView, response_model_by_alias=True, status_code=201,
    summary="Duplicate a view",
    responses={202: {"description": "A view made from a query: what its sources reach is still being worked "
                                    "out, and nothing was made. Send the same request again to carry on."},
               **refusal_responses(403, 404, 409, 422, 429, 501, 503)},
)
async def duplicate_view(
    response: Response,
    view_id: str = Path(...),
    body: Optional[DuplicateRequest] = Body(None),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    engine_scope: EngineScope = Depends(get_engine_scope),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key", max_length=128),
):
    """Make a copy of a view: see the module docstring. 201 ``{view, membership?, search?}``.

    ``Idempotency-Key`` carries one copy on: a view made from a query answered 202 is asked
    again with the same key and carries on where it got to, and a list or subset copy sent
    again after no answer is the one already made. Without one, each request is a new copy."""
    body = body or DuplicateRequest()
    actor = _user_id(user)
    row, _ = await _view(session, view_id, user, claims, edit=False)
    config = config_of(row)
    name = body.name or f"Copy of {row.name}"[:NAME_MAX]
    workspace_id = body.workspace_id or row.workspace_id
    data_source_id = row.data_source_id
    if workspace_id != row.workspace_id:
        # Elsewhere, the copy names the data the view shows: never another workspace's default.
        data_source_id = await effective_data_source(session, row.workspace_id, row.data_source_id)
    label = dict(
        name=name, description=row.description[:DESCRIPTION_MAX] if row.description else None,
        icon=config.get("icon") if isinstance(config.get("icon"), str) else None, tags=_tags(row),
        visibility=body.visibility, workspace_id=workspace_id, data_source_id=data_source_id,
    )
    # The caller's key, bound to this view; without one, a fresh id: a new copy each time.
    request_key = (f"duplicate:{row.id}:{idempotency_key}" if idempotency_key
                   else f"duplicate-{uuid.uuid4().hex}")
    definition = read_definition(config)

    if definition is not None:
        await require_membership()
        layers =[layer for layer in ((config.get("layout") or {}).get("referenceLayout") or {}).get("layers") or []
                  if isinstance(layer, dict)]
        made = await make_list_view(response, FromMembersRequest(
            **label, mode=definition.mode, sources=definition.sources, layout=definition.layout,
            layers=layers or None, exclude=definition.exclude, provenance=definition.provenance,
            context_model_id=row.context_model_id, context_model_version=row.context_model_version,
        ), request_id=f"fm:{actor}:{request_key}", user=user, claims=claims, session=session,
            engine_scope=engine_scope, copy_of=ListViewCopy(view_id=row.id, name=row.name, config=config))
        if isinstance(made, Response):
            return made                     # 202: nothing made yet
        answer = {"membership": made.membership}
    elif is_subset(config):
        await require_search_views()
        search = read_search_definition(config)
        if search is None:
            raise refused(422, "invalid_search", "This subset view's search can't be read, so it can't be copied.")
        own = layers_of(config, add_rest=False) if search.layout == "own" else []
        made = await create_view_from_search(
            response=response, body=FromSearchRequest(
                **label, predicate=search.predicate, within=search.within, read_in=search.read_in,
                layout=search.layout, include=search.include, hidden_layers=search.hidden_layers,
                provenance=search.provenance,
                **({"layers": [SearchLayer(name=layer.name, color=layer.color, entity_types=layer.entity_types)
                               for layer in own if not layer.rest and layer.entity_types] or None,
                    "rest": next((layer.name for layer in own if layer.rest), None)} if own else {}),
            ), idempotency_key=request_key, user=user, claims=claims, session=session)
        answer = {"search": made.search}
    else:
        made = await _copy_view(session, row, config, label, user=user, claims=claims)
        answer = {}
    await _copy_queries(session, row.id, made.view.id, actor)
    content = {"view": made.view.model_dump(mode="json", by_alias=True),
               **{k: v.model_dump(mode="json", by_alias=True) for k, v in answer.items()}}
    return JSONResponse(status_code=response.status_code or 201, content=content)


def _tags(row: ViewORM) -> Optional[list]:
    try:
        tags = json.loads(row.tags) if row.tags else None
    except ValueError:
        return None
    return tags if isinstance(tags, list) and tags else None


class _Made(BaseModel):
    view: ViewResponse


async def _copy_view(session: AsyncSession, row: ViewORM, config: dict, label: dict, *, user,
                     claims: PermissionClaims) -> _Made:
    """An ordinary view's copy, checked as ``POST /views`` checks a new view: its design as it
    is — layers, what people placed, display rules, styles and filters — its template kept
    where the caller can use it."""
    actor = _user_id(user)
    req = ViewCreateRequest(
        name=label["name"], description=label["description"], workspace_id=label["workspace_id"],
        data_source_id=label["data_source_id"], view_type=row.view_type, config=copy.deepcopy(config),
        visibility=label["visibility"], tags=label["tags"],
    )
    await authorize_view_create(claims, session, workspace_id=req.workspace_id, data_source_id=req.data_source_id,
                                visibility=req.visibility)
    await ensure_view_mode_allowed(req.view_type, session)
    try:
        await view_repo.check_layer_rules(session, view_repo._base_reference_layout(req.config), {})
    except ValueError as exc:
        raise refused(422, "invalid_layers", str(exc)) from exc
    if row.context_model_id:
        req.context_model_id = await template_access.usable_template_id(
            session, user=user, claims=claims, template_id=row.context_model_id)
        req.context_model_version = await _template_version(session, req.context_model_id,
                                                            row.context_model_version)
    view = await view_repo.create_view(
        session, req, ontology_digest=await _compute_ontology_digest(session, req.workspace_id, req.data_source_id),
        user_id=actor)
    await view_activity_repo.record_view_activity(
        session, view_id=view.id, workspace_id=view.workspace_id, action="created", actor=actor,
        summary=f'Created "{view.name}" as a copy of "{row.name}"',
    )
    return _Made(view=view)


async def _copy_queries(session: AsyncSession, source_id: str, view_id: str, actor: Optional[str]) -> None:
    """The view's saved queries, the copy's own: a new id each, in the same order."""
    for position, query in enumerate(await view_library.read_queries(session, source_id)):
        session.add(ViewSavedQueryORM(
            id=f"q-{uuid.uuid4().hex[:16]}", view_id=view_id, position=position, name=query.name,
            description=query.description, predicate=json.dumps(query.predicate),
            created_by=actor, updated_by=actor,
        ))
    await session.flush()
