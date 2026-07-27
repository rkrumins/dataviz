"""Batched canvas endpoints (WS5).

``POST /canvas/bootstrap`` and ``POST /canvas/expand`` collapse a canvas
gesture into ONE request each by composing the existing engine read
methods concurrently and returning a single GraphCache-backed payload.
See ``backend/app/models/canvas.py`` for the contract rationale.

Both reuse the same scope/health/shed helpers as the per-purpose graph
endpoints, so the LKG stale-fallback, generation-bump invalidation, the
``_bounded_compute`` 429-shed lane, and branch-aware engine construction
(drafts → overlay provider) all apply unchanged.

Delegated access
----------------
This router is the render path for a saved view, so it is one of the two
that a **delegate** can reach — someone who can read a view through its
``enterprise`` or ``public`` tier but holds no binding in its workspace.
They pass ``?viewId=`` and are confined to that view's resolved scope;
see ``backend/app/auth/view_delegation.py``. Every confinement below is
skipped for ordinary members, whose requests are unchanged.

The delegate's ``scope_hash`` is folded into the GraphCache key. Without
that, a confined result and a member's full result would collide on the
same key and each could be served to the other.
"""
import asyncio
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _bounded_compute,
    _cache_scope,
    _enforce_fair_share,
    _provider_health_header,
    get_context_engine,
)
from backend.app.auth.view_delegation import ViewDelegation, get_delegation
from backend.app.db.engine import get_graph_read_db_session
from backend.app.models.canvas import (
    CanvasBootstrapRequest,
    CanvasBootstrapResult,
    CanvasExpandRequest,
    CanvasExpandResult,
    CanvasFreshness,
)
from backend.app.services.context_engine import ContextEngine
from backend.app.services.graph_cache import (
    CacheScope,
    ENDPOINT_CANVAS_BOOTSTRAP,
    ENDPOINT_CANVAS_EXPAND,
    get_graph_cache,
    get_source_stale_reason,
)
from backend.app.services.top_level_cache import try_serve_top_level
from backend.common.models.graph import (
    AggregatedEdgeInfo,
    AggregatedEdgeRequest,
    AggregatedEdgeResult,
    EdgeQuery,
    GraphEdge,
)

router = APIRouter()


def _merge_aggregated(
    parts: List[Optional[AggregatedEdgeResult]],
) -> Optional[AggregatedEdgeResult]:
    """Merge directional aggregated reads into one result, deduping by
    (source, target). Freshness/regime propagate from the first non-None
    part; ``stale`` is OR-ed and truncation is OR-ed so a partial leg is
    never hidden."""
    present = [p for p in parts if p is not None]
    if not present:
        return None
    by_pair: Dict[Tuple[str, str], AggregatedEdgeInfo] = {}
    total = 0
    for part in present:
        for e in part.aggregated_edges:
            key = (e.source_urn, e.target_urn)
            if key not in by_pair:
                by_pair[key] = e
                total += e.edge_count
    base = present[0]
    return AggregatedEdgeResult(
        aggregatedEdges=list(by_pair.values()),
        totalSourceEdges=total,
        truncated=any(p.truncated for p in present),
        lastMaterializedAt=base.last_materialized_at,
        materializationTriggered=any(
            getattr(p, "materialization_triggered", False) for p in present),
        stale=any(getattr(p, "stale", False) for p in present),
        staleReason=next(
            (p.stale_reason for p in present if getattr(p, "stale_reason", None)), None),
        stampVersion=base.stamp_version,
        regime=base.regime,
    )


async def _apply_stale_overlay(
    scope: CacheScope,
    freshness: CanvasFreshness,
    aggregated: Optional[AggregatedEdgeResult],
) -> None:
    """Post-cache staleness overlay (Task 6), shared by bootstrap and
    expand: the source-changed marker is set/cleared independently of the
    cache entry, so a cached/composed response can be honestly stale
    without its own structural staleReason knowing it. Never overwrites
    an existing stale reason; never baked back into the cache."""
    reason = await get_source_stale_reason(scope.workspace_id, scope.data_source_id)
    if not reason:
        return
    if not freshness.stale:
        freshness.stale = True
        freshness.stale_reason = reason
    if aggregated is not None and not aggregated.stale:
        aggregated.stale = True
        aggregated.stale_reason = reason


def _delegate_entity_types(
    delegation: Optional[ViewDelegation], requested: Optional[List[str]],
) -> Optional[List[str]]:
    """Clamp requested entity types to what the view allows.

    An empty allow-list on the view means "no constraint from the view",
    so the request passes through. Otherwise the result is the
    intersection — a delegate can narrow, never widen.
    """
    if delegation is None:
        return requested
    allowed = delegation.scope.entity_type_allow_list
    if not allowed:
        return requested
    if not requested:
        return sorted(allowed)
    return sorted(set(requested) & set(allowed))


def _delegate_cache_params(
    delegation: Optional[ViewDelegation], params: Dict[str, object],
) -> Dict[str, object]:
    """Fold the delegation into the cache key.

    ``scope_hash`` already covers the view id, its ``updated_at``, the
    branch, and every resolved scope field — so editing the view or
    changing its scope naturally invalidates a delegate's cached payload.
    """
    if delegation is None:
        return params
    return {**params, "delegatedScope": delegation.scope.scope_hash}


async def _assert_expandable(
    engine: ContextEngine,
    delegation: Optional[ViewDelegation],
    parent_urn: str,
) -> None:
    """A delegate may only expand within the view they came in through.

    The view's scope is "these roots and what they contain", so a node
    qualifies when it *is* a root or has one among its ancestors. Views
    with no explicit roots derive their scope from entity types at query
    time; there is no URN set to check against, and the entity-type clamp
    is what bounds those.

    Costs one ancestors lookup, for delegates only.
    """
    if delegation is None:
        return
    roots = set(delegation.scope.root_urns)
    if not roots or parent_urn in roots:
        return
    ancestors = await engine.get_ancestors(parent_urn)
    if roots.intersection(a.urn for a in ancestors):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "outside_view_scope",
            "view_id": delegation.view_id,
            "message": "That node is outside the view you have access to",
        },
    )


@router.post("/canvas/bootstrap", response_model=CanvasBootstrapResult, response_model_by_alias=True)
async def canvas_bootstrap(
    response: Response,
    request: CanvasBootstrapRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
    # WS0.2 bulkhead: held across the outbound FalkorDB call (materialized
    # top-level serve + provider reads) — isolate from the WEB pool.
    session: AsyncSession = Depends(get_graph_read_db_session),
    # Injected by FastAPI on the annotation, so position doesn't matter;
    # optional and last so the handler stays directly callable from tests
    # that exercise the aggregation logic without an HTTP request.
    http_request: Request = None,  # type: ignore[assignment]
) -> CanvasBootstrapResult:
    """Everything needed to paint the initial canvas in one request: the
    root page, the edges among those roots, and the aggregated lineage
    among them, plus freshness + provider health."""
    await _enforce_fair_share(engine, ENDPOINT_CANVAS_BOOTSTRAP)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)
    scope = _cache_scope(engine)
    delegation = get_delegation(http_request)
    entity_types = _delegate_entity_types(delegation, request.entity_types)

    async def compute() -> CanvasBootstrapResult:
        # Wave 1 — roots page (materialized-serve fast path when eligible,
        # else the live label-union read).
        roots = None
        if (
            scope is not None
            and not scope.branch_id
            and scope.data_source_id
            and not request.search_query
            and not entity_types
            # The materialized top-level cache is not view-aware, so it
            # cannot serve a confined roots page.
            and delegation is None
        ):
            served, _known = await try_serve_top_level(
                session, engine,
                ds_id=scope.data_source_id, ws_id=scope.workspace_id,
                limit=request.limit, cursor=request.cursor,
            )
            roots = served
        if roots is None:
            roots = await engine.get_top_level_or_orphan_nodes(
                entity_types=entity_types,
                search_query=request.search_query,
                limit=request.limit,
                cursor=request.cursor,
                include_child_count=True,
            )

        # A delegate sees the view's roots, not the workspace's. When the
        # view declares explicit roots, that intersection IS the page.
        if delegation is not None and delegation.scope.root_urns:
            allowed = set(delegation.scope.root_urns)
            kept = [n for n in roots.nodes if n.urn in allowed]
            roots = roots.model_copy(update={"nodes": kept})

        root_urns = [n.urn for n in roots.nodes]

        # Wave 2 — edges among roots + aggregated lineage among roots,
        # both bounded by the root set and run CONCURRENTLY.
        async def _edges() -> List[GraphEdge]:
            if len(root_urns) < 2:
                return []
            return await engine.get_edges(EdgeQuery(
                source_urns=root_urns, target_urns=root_urns,
            ))

        async def _aggregated() -> Optional[AggregatedEdgeResult]:
            if not request.include_aggregated or not root_urns:
                return None
            return await engine.get_aggregated_edges(AggregatedEdgeRequest(
                sourceUrns=root_urns, targetUrns=root_urns,
                lineageEdgeTypes=request.lineage_edge_types,
                containmentEdgeTypes=request.containment_edge_types,
            ))

        edges, aggregated = await asyncio.gather(_edges(), _aggregated())
        return CanvasBootstrapResult(
            roots=roots,
            edges=edges,
            aggregated=aggregated,
            freshness=CanvasFreshness.from_aggregated(aggregated),
            providerHealth=_provider_health_header(engine),
        )

    if scope is None:
        return await compute()
    result = await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_CANVAS_BOOTSTRAP,
        params=_delegate_cache_params(delegation, {
            "entityTypes": sorted(entity_types) if entity_types else None,
            "searchQuery": request.search_query,
            "limit": request.limit,
            "cursor": request.cursor,
            "includeAggregated": request.include_aggregated,
            "lineageEdgeTypes": sorted(request.lineage_edge_types) if request.lineage_edge_types else None,
            "containmentEdgeTypes": sorted(request.containment_edge_types) if request.containment_edge_types else None,
        }),
        compute=_bounded_compute(engine, compute),
        model_cls=CanvasBootstrapResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )
    await _apply_stale_overlay(scope, result.freshness, result.aggregated)
    return result


@router.post("/canvas/expand", response_model=CanvasExpandResult, response_model_by_alias=True)
async def canvas_expand(
    response: Response,
    request: CanvasExpandRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
    # See canvas_bootstrap — injected on the annotation, optional and last.
    http_request: Request = None,  # type: ignore[assignment]
) -> CanvasExpandResult:
    """One container expand: its children page (+ edges) and the aggregated
    DELTA — only the aggregated edges the new children introduce, in either
    direction, against the rest of the visible set."""
    await _enforce_fair_share(engine, ENDPOINT_CANVAS_EXPAND)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)
    scope = _cache_scope(engine)
    delegation = get_delegation(http_request)
    await _assert_expandable(engine, delegation, request.parent_urn)

    async def compute() -> CanvasExpandResult:
        children = await engine.get_children_with_edges(
            request.parent_urn,
            lineage_edge_types=request.lineage_edge_types,
            limit=request.limit,
            cursor=request.cursor,
            include_lineage_edges=True,
        )
        new_urns = [c.urn for c in children.children]

        aggregated: Optional[AggregatedEdgeResult] = None
        if request.include_aggregated and new_urns:
            # Invariant 12: the just-expanded parent is represented by its
            # children now — exclude it from the aggregation set so the
            # containment rollup isn't double-counted.
            targets = [
                u for u in dict.fromkeys([*request.visible_urns, *new_urns])
                if u != request.parent_urn
            ]

            async def _fanout() -> AggregatedEdgeResult:
                return await engine.get_aggregated_edges(AggregatedEdgeRequest(
                    sourceUrns=new_urns, targetUrns=targets,
                    lineageEdgeTypes=request.lineage_edge_types,
                    containmentEdgeTypes=request.containment_edge_types,
                ))

            async def _fanin() -> AggregatedEdgeResult:
                return await engine.get_aggregated_edges(AggregatedEdgeRequest(
                    sourceUrns=targets, targetUrns=new_urns,
                    lineageEdgeTypes=request.lineage_edge_types,
                    containmentEdgeTypes=request.containment_edge_types,
                ))

            out, inb = await asyncio.gather(_fanout(), _fanin())
            aggregated = _merge_aggregated([out, inb])

        return CanvasExpandResult(
            children=children,
            aggregatedDelta=aggregated,
            freshness=CanvasFreshness.from_aggregated(aggregated),
        )

    if scope is None:
        return await compute()
    import hashlib
    visible_digest = hashlib.sha256(
        ",".join(sorted(request.visible_urns)).encode()
    ).hexdigest()
    result = await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_CANVAS_EXPAND,
        params=_delegate_cache_params(delegation, {
            "parentUrn": request.parent_urn,
            "cursor": request.cursor,
            "limit": request.limit,
            "visibleDigest": visible_digest,
            "includeAggregated": request.include_aggregated,
            "lineageEdgeTypes": sorted(request.lineage_edge_types) if request.lineage_edge_types else None,
            "containmentEdgeTypes": sorted(request.containment_edge_types) if request.containment_edge_types else None,
        }),
        compute=_bounded_compute(engine, compute),
        model_cls=CanvasExpandResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )
    await _apply_stale_overlay(scope, result.freshness, result.aggregated_delta)
    return result
