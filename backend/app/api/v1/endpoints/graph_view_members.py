"""``POST /{ws_id}/graph/view-members?viewId=`` — one page of one layer of a view made from a
query: its members, in name order, as the nodes the canvas draws.

A view made from a query holds up to a quarter of a million members (``view_members``), so the
canvas never loads them at once: each layer lists its members a page at a time, as a subset
view's layers list their matches (``graph_view_feed``), in the same shape (``ViewFeedPage``),
for as long as it has members — every one of them, unless an operator sets a ceiling
(``VIEW_MEMBERS_FEED_MAX_ROWS``). The members are the ones readers see (``members_epoch``): a
run working out the next answer is never half seen. Mounted under the graph prefix behind the
data-source-or-view gate, as every graph read is; a share link reads its own view only.

One page is one keyset read of the member table (``idx_vm_feed``: layer, then name), its
count (kept in this process per view, answer and layer), then three graph statements, each
admitted on its own: the members' nodes, where they sit (their containers, the canvas draws
around them — as many of the nearest as ``inLayer`` says), and those containers' names. A
page is cached under the view, the answer it reads, the layer, the cursor and the data's
version. What people placed in the layer themselves ("Always include") is in its count; the
canvas loads those from the view's layout.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
from collections import OrderedDict
from contextlib import nullcontext
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _cache_scope,
    _map_not_implemented,
    _search_data_version,
    _statement_admission,
    _view_reader,
    get_context_engine,
    get_engine_session,
)
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.db.models import ViewMembershipStateORM, ViewORM, view_is_live
from backend.app.db.repositories import view_members_repo
from backend.app.services.context_engine import ContextEngine
from backend.app.services.graph_cache import ENDPOINT_VIEW_FEED, get_graph_cache
from backend.app.services.live_views import layouts
from backend.app.services.live_views.pipeline import config_of, layout_of, source_config
from backend.app.services.search_views import in_followed_layers
from backend.common.models.graph import GraphNode, NodeQuery
from backend.common.models.search_view import ViewFeedPage, ViewMembersRequest
from backend.common.models.view_membership import MACHINE, MembershipDefinition, read_definition

router = APIRouter()


#: An operator's ceiling on the members a layer lists on the canvas — past it a page says
#: ``capped`` (search in the layer, or export it, for the rest). 0: none, every member.
VIEW_MEMBERS_FEED_MAX_ROWS: int = int(os.getenv("VIEW_MEMBERS_FEED_MAX_ROWS", "0"))

#: Layer counts kept in this process: (view, its answer, the view's last edit, layer) → count.
_COUNTS: "OrderedDict[Tuple[str, int, str, str], int]" = OrderedDict()
_COUNTS_MAX = 4096


async def _count(session: AsyncSession, view: ViewORM, epoch: int, layer_id: str) -> int:
    """How many members a layer holds, exactly — counted once per answer (and per edit:
    a move or a member kept out changes it without a new answer)."""
    key = (view.id, epoch, view.updated_at or "", layer_id)
    if key in _COUNTS:
        _COUNTS.move_to_end(key)
        return _COUNTS[key]
    count = await view_members_repo.count(session, view.id, epoch, layer_id)
    _COUNTS[key] = count
    while len(_COUNTS) > _COUNTS_MAX:
        _COUNTS.popitem(last=False)
    return count


#: Container names kept in this process: (physical graph, data version, URN) → (name, type).
_NAMES: "OrderedDict[Tuple[str, str, str], Tuple[str, str]]" = OrderedDict()
_NAMES_MAX = 50_000


async def layers_of(session: AsyncSession, view: ViewORM, config: dict,
                    definition: MembershipDefinition) -> Optional[List[dict]]:
    """The layers the view shows: its own, or — following a view — that view's (None
    once that view is gone)."""
    if definition.layout.kind != "follow":
        return layout_of(config)[0]
    base = await source_config(session, definition, view.workspace_id)
    return layouts.followed(base) if base is not None else None


def pinned(config: dict, definition: MembershipDefinition, layers: Optional[List[dict]],
           layer_id: str) -> Dict[str, dict]:
    """What people placed in the layer themselves ("Always include", never members) —
    following a view, each in the layer it is served there (``in_followed_layers``)."""
    own = {u: e for u, e in layout_of(config)[1].items() if e.get("assignedBy") != MACHINE}
    if definition.layout.kind == "follow":
        own = in_followed_layers(own, layers or [])
    return {u: e for u, e in own.items() if e.get("layerId") == layer_id}


def _tag(payload: str, binding: str, key: str) -> str:
    return hmac.new(key.encode(), f"view-members.{binding}.{payload}".encode(), hashlib.sha256).hexdigest()[:32]


def _binding(view_id: str, layer_id: str) -> str:
    """What a cursor is good for: this layer of this view. Not the answer: a name order
    goes on across an update, so a page read before one carries on after it."""
    return hashlib.sha256(json.dumps([view_id, layer_id]).encode()).hexdigest()[:16]


def _read_cursor(raw: Optional[str], binding: str) -> Dict[str, Any]:
    """A cursor: where the last page ended (``k``, ``u``: its keyset) and how many rows
    the layer has listed (``d``) — signed, so neither can be made up. Anything this
    server didn't issue for this layer is refused."""
    if not raw:
        return {"k": None, "u": None, "d": 0}
    from backend.auth_service.core import config as auth_config

    payload, sep, tag = raw.partition(".")
    state = None
    if sep and any(hmac.compare_digest(tag, _tag(payload, binding, key))
                   for _kid, key in auth_config.JWT_VERIFICATION_KEYS):
        try:
            state = json.loads(base64.urlsafe_b64decode(payload.encode() + b"=" * (-len(payload) % 4)))
        except (ValueError, TypeError):
            state = None  # not base64, or not JSON: malformed, answered below
    if (isinstance(state, dict) and isinstance(state.get("k"), str) and isinstance(state.get("u"), str)
            and isinstance(state.get("d"), int) and state["d"] >= 0):
        return state
    raise refused(400, "bad_cursor", "cursor is malformed — start from the first page")


def _write_cursor(key: str, urn: str, delivered: int, binding: str) -> str:
    from backend.auth_service.core import config as auth_config

    raw = json.dumps({"k": key, "u": urn, "d": delivered}, separators=(",", ":"))
    payload = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    return f"{payload}.{_tag(payload, binding, auth_config.JWT_SECRET_KEY)}"


async def _read(admit, call):
    async with (admit() if admit is not None else nullcontext()):
        return await call()


async def _nodes(engine: ContextEngine, rows: List[Any], admit, *, graph_ns: str = "",
                 data_version: str = "", gone: bool = True) -> List[Dict[str, Any]]:
    """The page's members as the canvas draws them: each node, where it sits
    (``ancestorPath``, root first: every container, a name not found ``""``, so
    ``inLayer`` counts the right ones) and how many of its nearest containers sit in its
    layer too (``inLayer``), which the canvas draws it inside. A reader with no
    containment walk ships them without a path. A member the graph no longer holds is
    drawn from what the member table knows of it, until the next update takes it out —
    or, without ``gone``, left out.

    The nodes and their paths are read side by side, each statement admitted on its own;
    then the names of the containers neither on the page nor named on this data before
    (``_NAMES``)."""
    urns = [r.urn for r in rows]
    if not urns:
        return []

    async def paths() -> Optional[Dict[str, List[str]]]:
        try:
            return await _read(admit, lambda: engine.get_ancestor_chains(urns))
        except NotImplementedError:
            return None

    # Both settle before an error is raised: neither is left running unobserved.
    found, chains = await asyncio.gather(
        _read(admit, lambda: engine.get_nodes_query(NodeQuery(urns=urns, limit=len(urns), include_child_count=False))),
        paths(), return_exceptions=True)
    for got in (found, chains):
        if isinstance(got, BaseException):
            raise got
    by_urn = {n.urn: n for n in found}
    if not gone:
        rows = [r for r in rows if r.urn in by_urn]
    drawn = {r.urn: by_urn.get(r.urn) or GraphNode(urn=r.urn, entityType=r.type or r.label or "",
                                                   displayName=r.name or r.urn) for r in rows}
    names: Dict[str, Tuple[str, str]] = {u: (n.display_name, n.entity_type) for u, n in drawn.items()}
    above = sorted({a for chain in (chains or {}).values() for a in chain} - set(names))
    if data_version:
        for a in above:
            if (graph_ns, data_version, a) in _NAMES:
                _NAMES.move_to_end((graph_ns, data_version, a))
                names[a] = _NAMES[(graph_ns, data_version, a)]
        above = [a for a in above if a not in names]
    if above:
        for n in await _read(admit, lambda: engine.get_nodes_query(
                NodeQuery(urns=above, limit=len(above), include_child_count=False))):
            names[n.urn] = (n.display_name, n.entity_type)
            if data_version:
                _NAMES[(graph_ns, data_version, n.urn)] = names[n.urn]
        while len(_NAMES) > _NAMES_MAX:
            _NAMES.popitem(last=False)
    out = []
    for r in rows:
        shaped = drawn[r.urn].model_dump(mode="json", by_alias=True)
        if chains is not None:
            shaped["ancestorPath"] = [
                {"urn": a, "displayName": names[a][0] if a in names else "",
                 "entityType": names[a][1] if a in names else ""}
                for a in reversed(chains.get(r.urn) or [])
            ]
        if r.in_layer:
            shaped["inLayer"] = r.in_layer
        out.append(shaped)
    return out


@router.post(
    "/view-members",
    response_model=ViewFeedPage,
    response_model_by_alias=True,
    summary="Read one page of one layer of a view made from a query",
    # Not behind ``viewMembershipEnabled``: the switch stops list views being made and
    # updated, and a view already made keeps the members it last had — which a reader
    # can only see through this feed, now that they are no longer in its layout.
    responses=refusal_responses(400, 403, 404, 429, 503),
)
async def view_members(
    request: Request,
    body: ViewMembersRequest = Body(...),
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The view whose layer is read."),
    dataSourceId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
) -> ViewFeedPage:
    """One page of a layer's members, in name order, with exactly how many the layer holds
    (``totalCount``: its members, and what people placed in it themselves). ``cursor``
    continues from the page before for as long as members remain (it is signed: one this
    server didn't issue for this layer is a 400). ``capped``: an operator's ceiling
    (``VIEW_MEMBERS_FEED_MAX_ROWS``) was reached — search in the layer, or export it, for
    the rest. A view whose members are not worked out yet holds none of its own."""
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
    if definition is None:
        raise refused(404, "not_made_from_a_query", "This view isn't made from a query.")
    epoch = (await session.execute(select(ViewMembershipStateORM.members_epoch).where(
        ViewMembershipStateORM.view_id == view.id))).scalar_one_or_none()
    binding = _binding(view.id, body.layer_id)
    cursor = _read_cursor(body.cursor, binding)
    max_rows = VIEW_MEMBERS_FEED_MAX_ROWS

    async def entries() -> int:
        return len(pinned(config, definition, await layers_of(session, view, config, definition), body.layer_id))

    if epoch is None:
        total = await entries()
        await session.commit()
        return ViewFeedPage(layer_id=body.layer_id, total_count=total, delivered=cursor["d"])
    data_version = await _search_data_version(engine)
    admit = _statement_admission(engine)

    async def compute() -> ViewFeedPage:
        delivered = cursor["d"]
        take = body.limit if max_rows <= 0 else max(0, min(body.limit, max_rows - delivered))
        after = (cursor["k"], cursor["u"]) if cursor["k"] is not None else None
        rows = await view_members_repo.page(session, view.id, epoch, body.layer_id, after, take + 1)
        members = await _count(session, view, epoch, body.layer_id)
        total = members + await entries()
        await session.commit()                 # nothing held while the graph answers
        more = len(rows) > take
        rows = rows[:take]
        nodes = await _nodes(engine, rows, admit, graph_ns=scope.graph_ns if scope is not None else "",
                             data_version=data_version)
        delivered += len(rows)
        ceiling = max_rows > 0 and delivered >= max_rows
        return ViewFeedPage(
            layer_id=body.layer_id, nodes=nodes,
            cursor=_write_cursor(rows[-1].sort_key, rows[-1].urn, delivered, binding)
            if more and rows and not ceiling else None,
            total_count=total, count_status="exact", status="complete",
            capped=ceiling and members > delivered, delivered=delivered, data_version=data_version,
        )

    scope = _cache_scope(engine)
    try:
        if scope is None:
            return await compute()
        return await get_graph_cache().get_or_compute(
            scope=scope, endpoint=ENDPOINT_VIEW_FEED,
            params={"members": view.id, "epoch": epoch, "edited": view.updated_at, "layer": body.layer_id,
                    "cursor": body.cursor, "limit": body.limit, "rows": max_rows, "data": data_version},
            compute=compute, model_cls=ViewFeedPage,
        )
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
