"""``/{ws_id}/graph/view-members/export`` and ``/download`` — one layer of a view made from a
query, as a file.

A layer lists its members on the canvas a page at a time (``/view-members``); the file holds
every one, and what people placed in the layer themselves ("Always include"). ``POST
/view-members/export`` checks the caller as the feed does and answers with how many rows the
file holds and a token for them — this layer, at the answer readers see now
(``members_epoch``), for this caller, for ten minutes. ``GET /view-members/download`` checks
the caller again and streams it: a keyset page of 5,000 members a short read (``idx_vm_feed``:
name order), each read in a session of its own, then the entries, their names read from the
graph 1,000 at a time; each row with where it sits — its parent and its path — from the
graph's containment chains, as a member set's file has them (``member_sets.download``), CSV
cells defused the same way. A file asked for after the view's members were worked out again
is still the answer the token names while its rows are kept, else the answer readers see now
— ``X-Members-Epoch`` says which.

Mounted under the graph prefix behind the data-source-or-view gate, and behind the export
switch, as a member set's download is.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import nullcontext
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _admit_graph_request,
    _principal,
    _statement_admission,
    _view_reader,
    get_context_engine,
    get_engine_session,
)
from backend.app.api.v1.endpoints.graph_export import ExportStreamResponse, take_turn
from backend.app.api.v1.endpoints.graph_member_sets import row_sessions
from backend.app.api.v1.endpoints.graph_view_members import layers_of, pinned
from backend.app.api.v1.feature_gate import require_feature
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.auth.dependencies import get_optional_user, get_permission_claims
from backend.app.db.engine import get_db_session, get_graph_read_db_session
from backend.app.db.models import ViewMemberORM, ViewORM, view_is_live
from backend.app.db.repositories import view_members_repo
from backend.app.services import view_access
from backend.app.services.live_views.pipeline import config_of
from backend.app.services.member_sets import download
from backend.app.services.search_downloads import VIEW_MEMBERS, mint_download_token, read_download_token
from backend.common.models.graph import NodeQuery
from backend.common.models.search_view import ViewMembersExport
from backend.common.models.view_membership import read_definition

router = APIRouter()

require_export = require_feature("graphExportEnabled")

#: How long a layer's download link works once issued.
EXPORT_TOKEN_SECONDS = 600
#: Members per read of the member table.
PAGE = 5_000
#: A member's row in the file: what it is, its layer, why it is in, and where it sits.
COLUMNS = ("urn", "name", "type", "layer", "via", "hops", "whole",
           "parentUrn", "parentName", "parentType", "path", "pathUrns")
FORMATS = ("csv", "ndjson")

_EXPIRED = "This download link has expired. Export the layer again."


def _name(layers: List[dict], layer_id: str) -> Optional[str]:
    layer = next((l for l in layers if l.get("id") == layer_id), None)
    if layer is None:
        return None
    return layer.get("name") if isinstance(layer.get("name"), str) and layer["name"] else layer_id


async def _list_view(request: Request, session: AsyncSession, ws_id: Optional[str], view_id: str,
                     can_read) -> ViewORM:
    if not ws_id:
        raise refused(400, "workspace_required", "workspace_id is required (path param ws_id)")
    capability = getattr(request.state, "view_capability", None)
    if capability and capability != view_id:
        raise refused(403, "link_other_view", "This link can only read its own view.")
    view = (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id, view_is_live()))).scalar_one_or_none()
    if view is None or view.workspace_id != ws_id or not await can_read(view):
        raise refused(404, "view_not_found", f"View '{view_id}' not found")
    return view


@router.post(
    "/view-members/export",
    response_model=ViewMembersExport,
    response_model_by_alias=True,
    summary="Ready one layer of a view made from a query to download",
    responses=refusal_responses(400, 403, 404, 409),
    dependencies=[Depends(require_export)],
)
async def export_view_members(
    request: Request,
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The view whose layer is exported."),
    layerId: str = Query(..., min_length=1, max_length=200),
    dataSourceId: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
    user=Depends(get_optional_user),
) -> ViewMembersExport:
    """How many rows the layer's file holds now (``rows``: its members, and what people
    placed in it themselves), the answer its members are read at (``epoch``), and a
    ``downloadToken`` for ``GET /view-members/download`` — for this caller, for ten minutes."""
    from backend.auth_service.core import config as auth_config

    view = await _list_view(request, session, ws_id, viewId, can_read_view)
    config = config_of(view)
    definition = read_definition(config)
    if definition is None:
        raise refused(404, "not_made_from_a_query", "This view isn't made from a query.")
    layers = await layers_of(session, view, config, definition)
    if layers is None:
        raise refused(409, "base_missing", "The view this one follows is no longer available.")
    if _name(layers, layerId) is None:
        raise refused(404, "no_such_layer", f"This view has no layer {layerId!r}.")
    epoch = await view_members_repo.members_epoch(session, view.id)
    rows = (await view_members_repo.count(session, view.id, epoch, layerId)
            + len(pinned(config, definition, layers, layerId)))
    await session.commit()
    token = mint_download_token(view.id, json.dumps([epoch, layerId]), _principal(user), auth_config.JWT_SECRET_KEY,
                                ttl_s=EXPORT_TOKEN_SECONDS, purpose=VIEW_MEMBERS)
    return ViewMembersExport(download_token=token, rows=rows, epoch=epoch)


async def _entries(entries: Dict[str, dict], layer: str, engine: Any, admit: Any) -> List[Dict[str, Any]]:
    """What people placed in the layer, as the file's rows, in name order: each one's name
    and type from the graph, ``download.LOOKUP`` to a statement, each admitted on its own."""
    urns = sorted(entries)
    records: List[Dict[str, Any]] = []
    for i in range(0, len(urns), download.LOOKUP):
        batch = urns[i:i + download.LOOKUP]
        async with (admit() if admit is not None else nullcontext()):
            nodes = await engine.get_nodes_query(NodeQuery(urns=batch, limit=len(batch), include_child_count=False))
        by_urn = {n.urn: n for n in nodes}
        for urn in batch:
            node = by_urn.get(urn)
            records.append({"urn": urn, "name": node.display_name if node is not None else None,
                            "type": node.entity_type if node is not None else None, "layer": layer,
                            "via": "entry", "hops": None,
                            "whole": entries[urn].get("inheritsChildren") is not False,
                            "parentUrn": None, "parentName": None, "parentType": None, "path": None,
                            "pathUrns": None})
    records.sort(key=lambda r: view_members_repo.sort_key(r["name"], r["urn"]))
    return records


async def _file(sessions, view_id: str, epoch: Optional[int], layer_id: str, layer: str, fmt: str,
                engine: Any, admit: Any, entries: Dict[str, dict]) -> AsyncIterator[bytes]:
    """The layer's members in name order, a page at a time, then what people placed in it
    themselves — each with where it sits."""
    if fmt == "csv":
        yield download._header(COLUMNS)
    known: Dict[str, Any] = {}
    after = None
    while epoch is not None:
        async with sessions() as session:
            rows = await view_members_repo.page(session, view_id, epoch, layer_id, after, PAGE)
        if not rows:
            break
        after = (rows[-1].sort_key, rows[-1].urn)
        # A member whose type was not read (an answer restored, until its next update) has
        # its label's, as the feed draws it.
        records = [{"urn": r.urn, "name": r.name, "type": r.type or r.label or None, "layer": layer,
                    "via": r.via, "hops": r.hops, "whole": bool(r.whole), "parentUrn": None, "parentName": None,
                    "parentType": None, "path": None, "pathUrns": None} for r in rows]
        await download._place(records, engine, admit, known)
        yield await asyncio.to_thread(download._encode, records, fmt, COLUMNS, True)
        if len(rows) < PAGE:
            break
    records = await _entries(entries, layer, engine, admit)
    for i in range(0, len(records), PAGE):
        chunk = records[i:i + PAGE]
        await download._place(chunk, engine, admit, known)
        yield await asyncio.to_thread(download._encode, chunk, fmt, COLUMNS, True)


@router.get(
    "/view-members/download",
    summary="One layer of a view made from a query, as a file",
    responses=refusal_responses(400, 403, 404, 422, 429),
    dependencies=[Depends(require_export)],
)
async def download_view_members(
    request: Request,
    token: str = Query(..., max_length=2048),
    format: str = Query("csv", description="csv or ndjson."),
    ws_id: Optional[str] = None,
    viewId: Optional[str] = Query(None, description="The view a share link reads through."),
    dataSourceId: Optional[str] = Query(None),
    # Function-scoped: given back before the body streams. The file is read a page at a
    # time in sessions of its own (``row_sessions``).
    _admission: None = Depends(_admit_graph_request, scope="function"),
    session: AsyncSession = Depends(get_graph_read_db_session, scope="function"),
    # The session the route's gate read the data source with (the same one, per request).
    gate: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    claims=Depends(get_permission_claims),
    sessions=Depends(row_sessions),
):
    """The layer the token names, streamed as it is read, at the answer it names — for the
    person it was issued to, for ten minutes after, while they can still read the view (an
    API key's selection holds too: the token names the view, the key must reach it). 403
    ``link_expired``: the token is expired, someone else's, or not one this server issued.
    The view's members worked out again since, and that answer no longer kept, the file is
    the answer readers see now. ``X-Members-Epoch``: the answer it holds."""
    from backend.auth_service.core import config as auth_config

    vouched = read_download_token(token, _principal(user),
                                  [key for _kid, key in auth_config.JWT_VERIFICATION_KEYS], purpose=VIEW_MEMBERS)
    try:
        epoch, layer_id = json.loads(vouched[1]) if vouched is not None else (None, None)
    except (TypeError, ValueError):
        layer_id = None
    if vouched is None or not isinstance(layer_id, str):
        raise refused(403, "link_expired", _EXPIRED)
    fmt = format.lower()
    if fmt not in FORMATS:
        raise refused(422, "invalid_format", "Ask for csv or ndjson.")
    if not ws_id:
        raise HTTPException(status_code=400, detail="workspace_id is required (path param ws_id)")
    viewer = await view_access.ViewerContext.build(session, user=user, claims=claims)

    async def can_read(view: ViewORM) -> bool:
        return await view_access.can_read_view(session, viewer, view)

    view = await _list_view(request, session, ws_id, vouched[0], can_read)
    config = config_of(view)
    definition = read_definition(config)
    if definition is None:
        raise refused(404, "not_made_from_a_query", "This view isn't made from a query.")
    layers = await layers_of(session, view, config, definition)
    layer = _name(layers or [], layer_id) or layer_id
    current = await view_members_repo.members_epoch(session, view.id)
    if epoch is None or (epoch != current and (await session.execute(select(ViewMemberORM.urn).where(
            ViewMemberORM.view_id == view.id, ViewMemberORM.epoch == epoch).limit(1))).first() is None):
        epoch = current     # the answer it names is no longer kept: the one readers see now
    engine = await get_context_engine(ws_id=ws_id, dataSourceId=dataSourceId, connectionId=None, branchId=None,
                                      asOfSeq=None, _admission=None, session=session, user=user, claims=claims)
    await session.commit()
    # The gate's read is done: give its connection back now, not when the download ends.
    await gate.commit()
    turn = await take_turn()
    return ExportStreamResponse(
        _file(sessions, view.id, epoch, layer_id, layer, fmt, engine, _statement_admission(engine),
              pinned(config, definition, layers, layer_id)),
        turn=turn, fmt=fmt, filename=f"{view.name or 'view'}-{layer}",
        headers={"X-Members-Epoch": str(epoch)} if epoch is not None else None)
