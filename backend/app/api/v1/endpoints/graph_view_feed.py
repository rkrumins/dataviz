"""``POST /{ws_id}/graph/search/view-feed?viewId=`` — one page of one layer of a
subset view: the matches of its stored search, as the nodes the canvas draws.

The view decides what matches. The page's search is the view's own — its base's
scope, read as the system, its search, and the layer's types — never a predicate
the client sends, so a share link's reader sees what the view shows and nothing
wider. Mounted under the graph prefix behind the data-source-or-view gate, as
every graph read is.

Built to be read by many while its graph is written to:

* **Shared.** A page is cached under the scope its matches are looked for in and
  the layer's types — not under the view — so every view and viewer asking the
  same question share one answer (single-flight in a pod, leader election across
  pods), and the search engine's sessions share the scan behind it.
* **Recent, not cold.** After the data changes, a feed's last complete page still
  answers, marked stale and as of when it was read, for a window
  (``DEEP_SEARCH_VIEW_FEED_REUSE``, spread per feed): a hot feed on a busy graph
  is scanned at most once a window, however often the graph is written.
* **Its own lane.** Only the request moving a scan on takes a slot of this
  process's feed lane (``DEEP_SEARCH_VIEW_FEED_LANE``) and a token of the
  workspace's ``view-feed`` fair share, while it holds the scan's lease; an
  answer from what is already there, or a wait on another request's scan, takes
  neither. When the lane is full a first page serves any recent answer (only
  with nothing to show is it a 429), and a scan in flight answers as it stands.
* **Bounded.** A layer lists at most ``DEEP_SEARCH_VIEW_FEED_MAX_ROWS`` rows on
  the canvas; past them the page says ``capped``, and the layer is searched or
  exported instead.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import time
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _cache_scope,
    _enforce_fair_share,
    _map_not_implemented,
    _map_validation_error,
    _search_data_version,
    _statement_admission,
    _view_reader,
    get_context_engine,
    get_engine_session,
)
from backend.app.api.v1.feature_gate import require_feature
from backend.app.jobs.metrics import increment
from backend.app.services.context_engine import ContextEngine
from backend.app.services.deep_search import (
    NothingReusable,
    SearchRunContext,
    get_deep_search_settings,
)
from backend.app.services.graph_cache import ENDPOINT_VIEW_FEED, get_graph_cache
from backend.app.services.search_views import (
    BasePlacement,
    containers_here,
    layer_condition,
    scope_types,
)
from backend.common.adapters import ProviderBusy
from backend.common.models.search import SearchOptions, SearchQuery, SearchResultPage, SearchScope
from backend.common.models.search_view import SubsetLayer, ViewFeedPage, ViewFeedRequest

router = APIRouter()

#: A preview: it ships off, and a flag that cannot be read means off.
require_search_views = require_feature("searchViewsEnabled", default=False)

#: Rows per page: whole pages of the engine's 1,000-row sessions, so every page
#: size the canvas asks for shares one session.
PAGE_SIZE = 200

#: How long a client is told to wait when the lane is full and nothing recent can
#: answer.
_BUSY_RETRY_S = 2

_LANES: Dict[int, asyncio.Semaphore] = {}


def _lane() -> asyncio.Semaphore:
    """This process's feed lane (one per event loop)."""
    loop = asyncio.get_running_loop()
    lane = _LANES.get(id(loop))
    if lane is None:
        lane = _LANES[id(loop)] = asyncio.Semaphore(get_deep_search_settings().view_feed_lane)
    return lane


def _read_cursor(raw: Optional[str]) -> Dict[str, Any]:
    """A feed cursor: the engine's, and how many rows the layer has listed."""
    if not raw:
        return {"c": None, "d": 0}
    try:
        state = json.loads(base64.urlsafe_b64decode(raw.encode() + b"=" * (-len(raw) % 4)))
    except (ValueError, TypeError):
        state = None  # not base64, or not JSON: malformed, answered below
    if isinstance(state, dict) and isinstance(state.get("c"), str) and isinstance(state.get("d"), int):
        return state
    raise HTTPException(status_code=400, detail="cursor is malformed — start from the first page")


def _write_cursor(engine_cursor: str, delivered: int) -> str:
    raw = json.dumps({"c": engine_cursor, "d": delivered}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _feed_page(layer: SubsetLayer, placement: Optional[BasePlacement], page: SearchResultPage,
               delivered_before: int, max_rows: int, reuse_s: int) -> ViewFeedPage:
    """A page of ``layer``'s matches as the canvas draws them: each with where it
    sits (``ancestorPath``, root first) and how many of its nearest containers
    sit in this layer too (``inLayer``), which the canvas draws it inside."""
    hits = (page.hits or [])[:max(0, max_rows - delivered_before)]
    here = containers_here(layer, placement, [hit.ancestor_path or [] for hit in hits])
    nodes = []
    for hit, in_layer in zip(hits, here):
        node = hit.node.model_dump(mode="json", by_alias=True)
        if hit.ancestor_path:
            node["ancestorPath"] = [a.model_dump(mode="json", by_alias=True)
                                    for a in hit.ancestor_path]
        if in_layer:
            node["inLayer"] = in_layer
        nodes.append(node)
    delivered = delivered_before + len(nodes)
    running = page.status == "running"
    more = page.cursor is not None
    out = ViewFeedPage(
        layer_id=layer.id, nodes=nodes,
        cursor=_write_cursor(page.cursor, delivered) if more and delivered < max_rows else None,
        total_count=page.total_count if page.total_count is not None else page.candidate_count,
        count_status="lowerBound" if running or page.count_status == "lowerBound" else "exact",
        status="running" if running else "complete",
        session_id=page.session_id, stale=page.stale, as_of=page.as_of,
        capped=more and delivered >= max_rows, delivered=delivered,
        data_version=page.data_version,
    )
    if out.stale and page.as_of:
        # Kept no longer than its window lets it answer: the window's shortest.
        age = time.time() - datetime.fromisoformat(page.as_of).timestamp()
        out._ttl_s = max(1, int(reuse_s * 0.8 - age))
    # Where its matches sit ran late: kept for seconds, so the next read draws them.
    out._paths_left_out = page._paths_left_out
    return out


@router.post(
    "/search/view-feed",
    response_model=ViewFeedPage,
    response_model_by_alias=True,
    dependencies=[Depends(require_search_views)],
)
async def view_feed(
    request: Request,
    response: Response,
    body: ViewFeedRequest = Body(...),
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The subset view whose layer is read."),
    dataSourceId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
) -> ViewFeedPage:
    """One page of a subset view's layer: its matches in order of name, with how
    many there are (exact once ``complete``; while ``running``, found so far —
    continue with ``sessionId``). ``stale`` with ``asOf``: a recent answer, read
    before the data last changed; ``refresh`` asks for one on the current data.
    ``capped``: more matches than the canvas lists — search in the layer, or
    export, for the rest. Answered from the published graph."""
    if not ws_id:
        raise HTTPException(status_code=400, detail="workspace_id is required (path param ws_id)")
    capability = getattr(request.state, "view_capability", None)
    if capability and capability != viewId:
        raise HTTPException(status_code=403, detail="This link can only read its own view.")
    from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError
    svc = AdvancedSearchService(
        engine, session=session, workspace_id=ws_id, data_source_id=dataSourceId,
        can_read_view=can_read_view, confined=bool(capability),
    )
    try:
        eff = await svc.resolve_scope(SearchScope(view_id=viewId, scope_mode="view"))
    except ValidationError as exc:
        detail = str(exc)
        if detail.startswith("base_missing:"):
            raise HTTPException(status_code=409, detail={
                "reason": "base_missing",
                "message": "This subset view's base view is no longer available."}) from exc
        raise _map_validation_error(detail) from exc
    if eff.search is None:
        raise HTTPException(status_code=409, detail={
            "reason": "not_a_subset", "message": "This view isn't a subset view."})
    layer = next((l for l in eff.subset_layers if l.id == body.layer_id), None)
    if layer is None:
        raise HTTPException(status_code=404, detail=f"This view has no layer {body.layer_id!r}.")

    settings = get_deep_search_settings()
    max_rows = settings.view_feed_max_rows
    cursor = _read_cursor(body.cursor)
    condition = layer_condition(layer, eff.subset_placement)
    types = scope_types(layer, eff.entity_type_allow_list, eff.subset_placement)
    if condition is None or types == [] or cursor["d"] >= max_rows:
        # A layer that can hold nothing here — or a client past the cap — is
        # answered without searching.
        return ViewFeedPage(layer_id=layer.id, total_count=0 if cursor["d"] == 0 else None,
                            delivered=cursor["d"], capped=cursor["d"] >= max_rows)

    reuse_s = 0 if body.refresh else settings.view_feed_reuse_seconds
    query = SearchQuery(
        predicate=condition,
        scope=SearchScope(view_id=viewId, scope_mode="view", entity_types=types or None),
        options=SearchOptions(results="hits", page_size=PAGE_SIZE, sort="displayName",
                              sort_dir="asc", cursor=cursor["c"], session_id=body.session_id,
                              wait_ms=body.wait_ms, include_ancestor_path=True),
    )
    data_version = await _search_data_version(engine)
    admit = _statement_admission(engine)

    @contextlib.asynccontextmanager
    async def feed_slot():
        """One of this process's feed-scan slots and a token of the workspace's
        fair share, taken by the engine for the request that moves a scan on,
        while it does (``SearchRunContext.slot``) — never by one waiting on
        another's scan. None free: no progress this time, and the scan stands."""
        lane = _lane()
        if lane.locked():
            increment("view_feed_answers_total", outcome="no_slot")
            yield False
            return
        async with lane:
            await _enforce_fair_share(engine, ENDPOINT_VIEW_FEED)
            increment("view_feed_answers_total", outcome="scan")
            yield True

    async def search(*, scan: bool, reuse: float) -> SearchResultPage:
        page, _eff = await svc.search(query, run_context=SearchRunContext(
            data_version=data_version, admit=admit, reuse_s=reuse, scan=scan, slot=feed_slot))
        return page

    async def busy() -> SearchResultPage:
        """Every slot is scanning and nothing answers yet: anything recent at
        all, before a 429."""
        try:
            page = await search(scan=False, reuse=settings.session_ttl_seconds)
            increment("view_feed_answers_total", outcome="busy_recent")
            return page
        except NothingReusable:
            increment("view_feed_answers_total", outcome="busy")
            raise ProviderBusy(provider_name="view-feed",
                               reason="every feed scan of this process is running",
                               retry_after_seconds=_BUSY_RETRY_S) from None

    async def compute() -> ViewFeedPage:
        if body.session_id:
            # Continuing a running scan: the request holding its lease moves it
            # on, in a slot; the others wait on that one's commit and hold none.
            # With no slot free, it answers as it stands and is asked again.
            page = await search(scan=True, reuse=reuse_s)
        else:
            try:
                page = await search(scan=False, reuse=reuse_s)
                increment("view_feed_answers_total",
                          outcome="stale" if page.stale else page.status or "complete")
            except NothingReusable:
                page = await (busy() if _lane().locked() else search(scan=True, reuse=reuse_s))
        return _feed_page(layer, eff.subset_placement, page, cursor["d"], max_rows,
                          settings.view_feed_reuse_seconds)

    scope = _cache_scope(engine)
    try:
        if body.session_id or body.refresh or scope is None:
            return await compute()
        stale_fallback = False

        def mark() -> None:
            nonlocal stale_fallback
            stale_fallback = True

        page = await get_graph_cache().get_or_compute(
            scope=scope, endpoint=ENDPOINT_VIEW_FEED,
            params={"scope": eff.scope_hash,
                    "condition": condition.model_dump(mode="json", by_alias=True),
                    "types": types, "cursor": cursor["c"], "delivered": cursor["d"],
                    "rows": max_rows, "size": PAGE_SIZE},
            compute=compute, model_cls=ViewFeedPage, on_stale=mark,
        )
        if stale_fallback:
            # The graph store didn't answer: its last complete answer, said so.
            response.headers["X-Cache-Status"] = "stale-fallback"
            page = page.model_copy(update={"stale": True})
        return page
    except ValidationError as exc:
        raise _map_validation_error(str(exc)) from exc
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
