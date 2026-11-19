"""``POST /{ws_id}/graph/view-placements?viewId=`` — where a view the server places draws each
of up to 2,000 entities: the layer, and why (``live_views.where``).

A trace drawn over a view places each of its cards in the layer the view draws that entity
in. The browser works that out itself for an ordinary view; a view made from a query keeps
its members in their own table, and a subset view finds its matches by search, so the
browser asks here instead. Mounted under the graph prefix behind the data-source-or-view
gate, checked as ``/view-members`` is: a share link reads its own view only, and a view the
caller can't read is not found. An answer is cached under the view, its members' answer, its
last edit, what decides placing, the URNs and the data's version.
"""
from __future__ import annotations

import hashlib
import json
from typing import Dict, Optional

from fastapi import APIRouter, Body, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _cache_scope,
    _map_not_implemented,
    _map_validation_error,
    _search_data_version,
    _statement_admission,
    _view_reader,
    get_context_engine,
    get_engine_session,
)
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.db.models import ViewORM, view_is_live
from backend.app.services.context_engine import ContextEngine
from backend.app.services.graph_cache import ENDPOINT_VIEW_PLACEMENTS, get_graph_cache
from backend.app.services.live_views import where
from backend.app.services.live_views.pipeline import config_of
from backend.app.services.search_views import is_subset
from backend.common.models.search import SearchScope
from backend.common.models.search_view import EntityPlacement, ViewPlacements, ViewPlacementsRequest
from backend.common.models.view_membership import read_definition

router = APIRouter()

_BASE_MISSING = "The view this one follows is no longer available, so it shows no layers to place in."


def _urns_key(urns) -> str:
    return hashlib.sha256(json.dumps(sorted(urns)).encode()).hexdigest()[:32]


@router.post(
    "/view-placements",
    response_model=ViewPlacements,
    response_model_by_alias=True,
    summary="Where a view made from a query, or a subset view, draws each of these entities",
    responses=refusal_responses(400, 403, 404, 409, 422, 429, 503),
)
async def view_placements(
    request: Request,
    body: ViewPlacementsRequest = Body(...),
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The view the entities are placed in."),
    dataSourceId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
) -> ViewPlacements:
    """Each URN (duplicates once) → the layer the view draws it in (``layerId``, None for
    nowhere) and why (``source``: ``member``, ``entry``, ``whole``, ``layout``, ``fallback``,
    ``none``). 409 ``base_missing``: the view it follows, or a subset's base, is gone. 422
    ``not_served_view``: an ordinary view, which the browser places itself."""
    if not ws_id:
        raise refused(400, "workspace_required", "workspace_id is required (path param ws_id)")
    capability = getattr(request.state, "view_capability", None)
    if capability and capability != viewId:
        raise refused(403, "link_other_view", "This link can only read its own view.")
    view = (await session.execute(
        select(ViewORM).where(ViewORM.id == viewId, view_is_live()))).scalar_one_or_none()
    if view is None or view.workspace_id != ws_id or not await can_read_view(view):
        raise refused(404, "view_not_found", f"View '{viewId}' not found")
    config = config_of(view)
    definition = read_definition(config)
    urns = list(dict.fromkeys(body.urns))
    admit = _statement_admission(engine)

    if definition is not None:
        try:
            listed = await where.list_view(session, view, config, definition)
        except where.BaseMissing as exc:
            raise refused(409, "base_missing", _BASE_MISSING) from exc
        epoch, digest = listed.epoch, listed.digest

        async def place() -> Dict[str, where.Where]:
            return await where.place_in_list(session, engine, view.id, listed, urns, admit=admit)
    elif is_subset(config):
        from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError

        svc = AdvancedSearchService(engine, session=session, workspace_id=ws_id, data_source_id=dataSourceId,
                                    can_read_view=can_read_view, confined=bool(capability))
        try:
            eff = await svc.resolve_scope(SearchScope(view_id=viewId, scope_mode="view"))
        except ValidationError as exc:
            if str(exc).startswith("base_missing:"):
                raise refused(409, "base_missing",
                              "This subset view's base view is no longer available.") from exc
            raise _map_validation_error(str(exc)) from exc
        await session.commit()
        epoch, digest = None, where.subset_digest(eff)

        async def place() -> Dict[str, where.Where]:
            return await where.place_in_subset(engine, eff, urns, admit=admit)
    else:
        raise refused(422, "not_served_view",
                      "This view's entities are placed from its own layout: place them in the browser.")

    data_version = await _search_data_version(engine)

    async def compute() -> ViewPlacements:
        placed = await place()
        return ViewPlacements(
            placements={u: EntityPlacement(layer_id=layer, source=source) for u, (layer, source) in placed.items()},
            epoch=epoch, data_version=data_version or None, digest=digest)

    scope = _cache_scope(engine)
    try:
        if scope is None:
            return await compute()
        return await get_graph_cache().get_or_compute(
            scope=scope, endpoint=ENDPOINT_VIEW_PLACEMENTS,
            params={"view": view.id, "epoch": epoch, "updated_at": view.updated_at, "digest": digest,
                    "urns": _urns_key(urns), "data_version": data_version},
            compute=compute, model_cls=ViewPlacements,
        )
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
