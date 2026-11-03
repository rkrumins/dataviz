"""``POST /{ws_id}/graph/members`` — resolve a membership spec.

Seeds and how far they reach in, the entities that names out: the Context View's
Narrow filter asks it today, and so will saving a view from a query, keeping it live,
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

from typing import Optional

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
from backend.app.services.feature_flags import feature_flags
from backend.app.services.graph_cache import ENDPOINT_TRACE_CLOSURE, get_graph_cache
from backend.app.services.view_membership import resolve_cached
from backend.app.services.view_membership_search import make_seed_search, seed_query_for
from backend.common.models.search import SearchQuery
from backend.common.models.view_membership import (
    MembershipDefinition,
    MembershipPlan,
    MembershipRequest,
    MembershipResult,
    PlanRequest,
)

router = APIRouter()

#: A preview: it ships off, and a flag that cannot be read means off — never the preview.
require_membership = require_feature("viewMembershipEnabled", default=False)

def _budget_s() -> float:
    """One resolution's wall clock on the web tier: the trace's own budget, so the
    answer arrives — truncated, and saying so — before the client stops waiting."""
    return max(5.0, resilience.TRACE_TIMEOUT_SECS - resilience.TRACE_ENGINE_HEADROOM_SECS)


def _answered_as_search(search):
    """The seed search, its refusals answered as the search route answers them."""
    from backend.app.services.advanced_search_service import ValidationError

    async def run(predicate):
        try:
            return await search(predicate)
        except ValidationError as exc:
            raise _map_validation_error(str(exc)) from exc

    return run


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
        seed_query = seed_query_for(spec, viewId)
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
    search = None
    if seed_query is not None:
        search = _answered_as_search(make_seed_search(svc, seed_query, data_version=data_version, admit=admit))

    try:
        return await resolve_cached(
            engine, spec,
            scope=_cache_scope(engine), cache=get_graph_cache(),
            read_in=viewId, boundary=boundary, search=search, admit=admit,
            budget_s=_budget_s(), include_members=body.include_members, data_version=data_version,
            on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
        )
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post(
    "/members/plan",
    response_model=MembershipPlan,
    response_model_by_alias=True,
    dependencies=[Depends(require_membership)],
)
async def plan_members(
    request: Request,
    response: Response,
    body: PlanRequest = Body(...),
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The view the plan is previewed from."),
    dataSourceId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
) -> MembershipPlan:
    """What saving these sources as a view would make — nothing is saved.

    The entries it would hold against the limit (its members, the containers drawn
    around them, and the entities always included), and each layer it would start
    with: its count, and whether it is kept (``keep``: ``withResults`` keeps only the
    layers that hold something). An answer that is short of the truth (out of time,
    part of the graph not answering) says so in ``truncated``.
    """
    from sqlalchemy import select

    from backend.app.db.models import ViewORM, view_is_live
    from backend.app.services.live_views import pipeline

    if any(s.spec.expand.upstream or s.spec.expand.downstream for s in body.sources) and not (
        await feature_flags.is_enabled_self_session("traceEnabled", default=fail_safe_default("traceEnabled"))
    ):
        raise feature_disabled("traceEnabled")
    for source in body.sources:
        if source.spec.seeds.query is not None:
            _guard_capability_scope(request, seed_query_for(source.spec, source.read_in))
    copied_from = None
    if body.layout.kind == "source":
        source_view = (await session.execute(select(ViewORM).where(
            ViewORM.id == (body.layout.source_view_id or viewId), view_is_live()))).scalar_one_or_none()
        if source_view is None or source_view.workspace_id != ws_id or not await can_read_view(source_view):
            raise HTTPException(status_code=404, detail="View not found")
        copied_from = pipeline.config_of(source_view)

    await _enforce_fair_share(engine, ENDPOINT_TRACE_CLOSURE)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)
    definition = MembershipDefinition(sources=body.sources, layout=body.layout, exclude=body.exclude)
    limit = pipeline.entry_limit()
    try:
        resolved = await pipeline.gather(
            engine, definition.sources, definition.layout, definition.exclude,
            workspace_id=ws_id, data_source_id=dataSourceId, budget_s=_budget_s(), limit=limit,
            can_read_view=can_read_view,
        )
        draft = pipeline.draft_view(definition, resolved, source_config=copied_from, client_layers=body.layers,
                                    keep=body.keep, limit=limit)
    except pipeline.PipelineError as exc:
        raise HTTPException(status_code=404 if exc.kind == "source_missing" else 422,
                            detail={"reason": exc.kind, "message": str(exc)}) from exc
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
    return pipeline.plan_answer(draft)
