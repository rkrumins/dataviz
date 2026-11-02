"""``POST /{ws_id}/graph/members`` — resolve a membership spec.

Seeds and how far they reach in, the entities that names out: the Context View's
Focus filter asks it today, and so will saving a view from a query, keeping it live,
a targeted export and any script with an API key (``backend/common/models/view_membership.py``
is the contract, ``backend/app/services/view_membership.py`` the resolver).

Mounted under the graph prefix behind the same data-source-or-view gate as every
graph read, so tenancy, API-key scope and a share link's view capability hold here
exactly as they do there. Under load it rides the existing bulkheads rather than
adding its own:

* one fair-share token per resolution, from the trace-closure bucket (a resolution
  is a burst of closure steps, which is what that bucket exists to pace);
* every graph statement inside it takes the per-(provider, graph) slot pair for
  that statement alone — never one slot held while its statements queue for more;
* the answer is cached under the spec's hash, the view's scope and the source's
  data generation: everyone asking the same question shares one walk (single-flight
  in a pod, leader election across pods), and a data change makes the next ask fresh.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _cache_scope,
    _enforce_fair_share,
    _guard_capability_scope,
    _map_not_implemented,
    _map_validation_error,
    _provider_health_header,
    _search_data_version,
    _statement_admission,
    _view_reader,
    get_context_engine,
    get_engine_session,
)
from backend.app.api.v1.feature_gate import feature_disabled, require_feature
from backend.app.config import resilience
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.services.context_engine import ContextEngine
from backend.app.services.deep_search import SearchRunContext
from backend.app.services.feature_flags import feature_flags
from backend.app.services.graph_cache import ENDPOINT_MEMBERS, ENDPOINT_TRACE_CLOSURE, get_graph_cache
from backend.app.services.view_membership import resolve_membership
from backend.common.models.search import Predicate, SearchOptions, SearchQuery, SearchScope
from backend.common.models.view_membership import SEEDS_MAX, MembershipRequest, MembershipResult

router = APIRouter()

#: A preview: it ships off, and a flag that cannot be read means off — never the preview.
require_membership = require_feature("viewMembershipEnabled", default=False)

#: How many times one query seed's search may be continued while it is still running.
_SEARCH_CONTINUATIONS = 10


def _budget_s() -> float:
    """One resolution's wall clock on the web tier: the trace's own budget, so the
    answer arrives — truncated, and saying so — before the client stops waiting."""
    return max(5.0, resilience.TRACE_TIMEOUT_SECS - resilience.TRACE_ENGINE_HEADROOM_SECS)


@router.post(
    "/members",
    response_model=MembershipResult,
    response_model_by_alias=True,
    dependencies=[Depends(require_membership)],
)
async def resolve_members(
    request: Request,
    response: Response,
    body: MembershipRequest = Body(...),
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The view the scope is read in."),
    dataSourceId: Optional[str] = Query(None),
    branchId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
) -> MembershipResult:
    """Resolve a scope: its seeds, what is inside them, their sources and consumers
    to a depth or the whole way, and what is inside those.

    The answer lists each entity in scope with why (``via``, and ``hops`` for a
    source or consumer), the members whose whole inside is in scope without being
    listed (``wholeSubtree``), each member's containers (``chains``), counts for each
    part, and every limit it reached (``truncated``). ``includeMembers: false``
    answers the counts alone. Lineage follows the trace's rules, and needs the
    Lineage trace switch on.
    """
    spec = body.spec
    if (spec.expand.upstream or spec.expand.downstream) and not await feature_flags.is_enabled_self_session(
        "traceEnabled", default=fail_safe_default("traceEnabled"),
    ):
        raise feature_disabled("traceEnabled")

    # A query seed is a search, and the checks a search makes on its caller — a share
    # link kept inside its own view; a view the caller can read, of the data source
    # searched — run HERE, before an answer can come from the cache, which keeps one
    # answer for every caller. The boundary's identity (the search's scope hash: the
    # view's design, and a draft's own layout over it) is in the key, so a changed
    # boundary is never answered from the old one. URN seeds are what they are
    # wherever the view's edges lie.
    seed_query: Optional[SearchQuery] = None
    boundary = ""
    if spec.seeds.query is not None:
        from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError
        seed_query = SearchQuery(
            predicate=spec.seeds.query,
            scope=SearchScope(view_id=viewId, scope_mode="view" if spec.within == "view" else "data_source"),
            options=SearchOptions(results="hits", page_size=SEEDS_MAX),
        )
        _guard_capability_scope(request, seed_query)
        svc = AdvancedSearchService(
            engine, session=session, workspace_id=ws_id, data_source_id=dataSourceId,
            branch_id=branchId, can_read_view=can_read_view,
        )
        try:
            boundary = (await svc.resolve_scope(seed_query.scope)).scope_hash
        except ValidationError as exc:
            raise _map_validation_error(str(exc)) from exc

    await _enforce_fair_share(engine, ENDPOINT_TRACE_CLOSURE)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)
    admit = _statement_admission(engine)
    data_version = await _search_data_version(engine)

    async def search(_predicate: Predicate) -> Tuple[List[str], bool]:
        """The query seed's hits: every entity it finds in the view (or the whole data
        source), up to the seed limit — the search panel's own search, continued while
        it is still running."""
        context = SearchRunContext(data_version=data_version, admit=admit)
        try:
            page, _scope = await svc.search(seed_query, run_context=context)
            for _ in range(_SEARCH_CONTINUATIONS):
                if page.status != "running" or not page.session_id:
                    break
                again = seed_query.model_copy(update={
                    "options": seed_query.options.model_copy(update={"session_id": page.session_id})})
                page, _scope = await svc.search(again, run_context=context)
        except ValidationError as exc:
            raise _map_validation_error(str(exc)) from exc
        urns = [hit.node.urn for hit in (page.hits or [])]
        more = (bool(page.cursor) or page.truncated or page.status == "running"
                or (page.total_count or 0) > len(urns))
        return urns, more

    async def compute() -> MembershipResult:
        return await resolve_membership(
            engine, spec, search=search, admit=admit, budget_s=_budget_s(),
            include_members=body.include_members, data_version=data_version,
        )

    try:
        scope = _cache_scope(engine)
        if scope is None:
            return await compute()
        return await get_graph_cache().get_or_compute(
            scope=scope,
            endpoint=ENDPOINT_MEMBERS,
            params={
                "spec": spec.spec_hash(),
                "viewId": viewId,
                "boundary": boundary,
                "members": body.include_members,
            },
            compute=compute,
            model_cls=MembershipResult,
            on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
            expected_compute_s=_budget_s(),
        )
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
