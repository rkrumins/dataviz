"""A view's saved narrowings: ``/views/{view_id}/narrowings``.

A reader narrows a view's canvas to chosen seeds and what they reach (a
membership spec), saves it with the view, and shares it: everyone who can
open the view lists it, and opening one (``?narrowSaved={id}`` on the view's
link) runs it again live and says what changed since it was saved — so each
keeps the URNs it held then, gzipped, read on their own route.

Anyone who can read the view lists, opens and reads them; any reader signed
in may save one; only whoever saved it, or an editor of the view, changes or
removes it. A view that can't be read answers 404, so its existence stays
private. Narrow is a preview: every route answers 403 while
``viewMembershipEnabled`` is off.

Mounted at ``/views`` before ``views.router``, like the other routes under a
view.
"""
from __future__ import annotations

import hashlib

from fastapi import APIRouter, Body, Depends, Path, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import _guard_capability_scope
from backend.app.api.v1.feature_gate import require_feature
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.api.v1.view_read_scope import viewer_context
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims, rbac_flag
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM, view_is_live
from backend.app.services import view_access, view_narrowings
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.view_membership_search import seed_query_for
from backend.auth_service.interface import User
from backend.common.models.view_membership import MembershipSpec
from backend.common.models.view_narrowing import (
    NARROWING_ID,
    SavedNarrowing,
    SavedNarrowingInput,
    SavedNarrowingList,
)

router = APIRouter()

#: Narrow's preview switch: off, and a flag that cannot be read means off.
require_membership = require_feature("viewMembershipEnabled", default=False)


async def _narrowing_view(session: AsyncSession, view_id: str, user,
                          claims: PermissionClaims) -> tuple[ViewORM, bool]:
    """The view, if the caller may read it (404 otherwise), and whether they
    may edit it. With ``RBAC_ENFORCE_VIEWS`` off, anyone may do both, as for
    the view's library."""
    row = (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id, view_is_live()))).scalar_one_or_none()
    if row is None:
        raise refused(404, "view_not_found", f"View '{view_id}' not found")
    if not rbac_flag("RBAC_ENFORCE_VIEWS"):
        return row, True
    ctx = await viewer_context(session, user, claims)
    if not await view_access.can_read_view(session, ctx, row):
        raise refused(404, "view_not_found", f"View '{view_id}' not found")
    return row, await view_access.can_edit_view(session, ctx, row)


def _hold_link_to_its_view(request: Request, claims: PermissionClaims, view: ViewORM,
                           spec: MembershipSpec) -> None:
    """A caller who reads the view's data only through the view (a share
    link: no ``workspace:datasource:read`` in its workspace) can't save a
    query seed they couldn't run there — the same fence ``POST
    /graph/members`` holds them to."""
    if spec.seeds.query is None:
        return
    key = claims.key_scope
    if (has_permission(claims, "workspace:datasource:read", workspace_id=view.workspace_id)
            and (key is None or key.selects_workspace(view.workspace_id))):
        return
    request.state.view_capability = view.id
    _guard_capability_scope(request, seed_query_for(spec, view.id))


def _refusal(exc: view_narrowings.NarrowingError):
    return refused(exc.status, exc.reason, exc.message)


@router.get(
    "/{view_id}/narrowings",
    response_model=SavedNarrowingList,
    response_model_by_alias=True,
    summary="A view's saved narrowings",
    responses=refusal_responses(403, 404),
    dependencies=[Depends(require_membership)],
)
async def list_view_narrowings(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> SavedNarrowingList:
    """The narrowings saved with the view, newest first, each with whether the
    caller may change it; whether they may edit the view; and how many a
    view, and one person on it, may keep."""
    _, can_edit = await _narrowing_view(session, view_id, user, claims)
    items = await view_narrowings.list_narrowings(
        session, view_id, actor=user.id if user else None, can_edit=can_edit)
    return SavedNarrowingList(items=items, can_edit=can_edit)


@router.get(
    "/{view_id}/narrowings/{narrowing_id}",
    response_model=SavedNarrowing,
    response_model_by_alias=True,
    summary="One saved narrowing",
    responses=refusal_responses(403, 404),
    dependencies=[Depends(require_membership)],
)
async def get_view_narrowing(
    view_id: str = Path(...),
    narrowing_id: str = Path(..., pattern=NARROWING_ID),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> SavedNarrowing:
    """A narrowing saved with the view: its spec, what it held when saved
    (the URNs themselves are at ``…/held``), and whether the caller may
    change it."""
    _, can_edit = await _narrowing_view(session, view_id, user, claims)
    try:
        return await view_narrowings.get_narrowing(
            session, view_id, narrowing_id, actor=user.id if user else None, can_edit=can_edit)
    except view_narrowings.NarrowingError as exc:
        raise _refusal(exc) from exc


@router.get(
    "/{view_id}/narrowings/{narrowing_id}/held",
    summary="The URNs a saved narrowing held",
    responses={200: {"content": {"application/gzip": {}},
                     "description": "The URNs it held when saved, sorted, one a line, gzipped."},
               204: {"description": "It keeps none."},
               **refusal_responses(304, 403, 404)},
    dependencies=[Depends(require_membership)],
)
async def get_view_narrowing_held(
    request: Request,
    view_id: str = Path(...),
    narrowing_id: str = Path(..., pattern=NARROWING_ID),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    """The URNs the narrowing held when it was saved — sorted, each once, one
    a line, gzipped — with an ``ETag``; 204 when it keeps none."""
    await _narrowing_view(session, view_id, user, claims)
    try:
        held = await view_narrowings.read_held(session, view_id, narrowing_id)
    except view_narrowings.NarrowingError as exc:
        raise _refusal(exc) from exc
    if held is None:
        return Response(status_code=204)
    etag = '"' + hashlib.sha256(held).hexdigest()[:32] + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(content=held, media_type="application/gzip", headers={"ETag": etag})


@router.put(
    "/{view_id}/narrowings/{narrowing_id}",
    response_model=SavedNarrowing,
    response_model_by_alias=True,
    summary="Save a narrowing with the view",
    responses={201: {"model": SavedNarrowing, "description": "Saved as a new narrowing."},
               **refusal_responses(403, 404, 409, 422)},
    dependencies=[Depends(require_membership)],
)
async def put_view_narrowing(
    request: Request,
    response: Response,
    view_id: str = Path(...),
    narrowing_id: str = Path(..., pattern=NARROWING_ID),
    body: SavedNarrowingInput = Body(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> SavedNarrowing:
    """Save a narrowing under this id: a new one (201), or a new version of
    one the caller saved or may edit as the view's editor (200). Everything
    is replaced as sent; ``held`` left out keeps the URNs already kept while
    the spec is the same. Refused: ``not_yours`` (403), ``id_taken`` (409:
    the id is another view's), ``invalid_spec``, ``too_many``,
    ``held_too_large`` and ``invalid_held`` (422)."""
    view, can_edit = await _narrowing_view(session, view_id, user, claims)
    try:
        spec = view_narrowings.check_spec(body.spec, read_in=view.id)
        _hold_link_to_its_view(request, claims, view, spec)
        saved, created = await view_narrowings.put_narrowing(
            session, view_id, narrowing_id, body, spec, actor=user.id, can_edit=can_edit)
    except view_narrowings.NarrowingError as exc:
        raise _refusal(exc) from exc
    response.status_code = 201 if created else 200
    return saved


@router.delete(
    "/{view_id}/narrowings/{narrowing_id}",
    status_code=204,
    summary="Remove a saved narrowing",
    responses=refusal_responses(403, 404),
    dependencies=[Depends(require_membership)],
)
async def delete_view_narrowing(
    view_id: str = Path(...),
    narrowing_id: str = Path(..., pattern=NARROWING_ID),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    """Remove a narrowing the caller saved, or any as an editor of the view
    (no error when it is already gone)."""
    _, can_edit = await _narrowing_view(session, view_id, user, claims)
    try:
        await view_narrowings.delete_narrowing(
            session, view_id, narrowing_id, actor=user.id, can_edit=can_edit)
    except view_narrowings.NarrowingError as exc:
        raise _refusal(exc) from exc
    return Response(status_code=204)
