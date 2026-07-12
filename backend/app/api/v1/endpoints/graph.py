from typing import List, Optional
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Body, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, RootModel

logger = logging.getLogger(__name__)
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.graph import (
    GraphNode, GraphEdge,
    NodeQuery, EdgeQuery,
    AggregatedEdgeRequest, AggregatedEdgeResult,
    CreateNodeRequest, CreateNodeResult,
    CreateEdgeRequest, UpdateEdgeRequest, EdgeMutationResult,
    BatchCommandRequest, BatchCommandResult, BatchResponse,
    ChildrenWithEdgesResult, TopLevelNodesResult,
    TraceRequest, TraceResult, ExpandRequest,
)
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.common.models.search import SearchQuery
from backend.app.services.context_engine import ContextEngine
from backend.app.services.fair_share import get_fair_share
from backend.app.services.graph_cache import (
    CacheScope,
    ENDPOINT_AGGREGATED,
    ENDPOINT_CHILDREN,
    ENDPOINT_EDGES_BETWEEN,
    ENDPOINT_NODES_QUERY,
    ENDPOINT_TOP_LEVEL,
    ENDPOINT_TRACE,
    ENDPOINT_TRACE_EXPAND,
    get_graph_cache,
)
from backend.app.services.stats_cache import (
    CacheMiss, SYNTHETIC_SCHEMA_MISSING_FIELDS,
    build_computing_envelope, build_envelope, build_error_envelope, build_meta,
    build_synthetic_schema, read_stats_cache,
)
from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session, get_graph_read_db_session
from backend.app.providers.manager import provider_manager
from backend.app.auth.dependencies import get_optional_user
from backend.app.services.top_level_cache import try_serve_top_level
from backend.insights_service.enqueue import (
    enqueue_stats_job_force,
    enqueue_stats_job_safe,
    mark_stats_changed,
)
from sqlalchemy.exc import OperationalError, SQLAlchemyError

router = APIRouter()

# Workspace-scoped mutation gate. The router-level dependency in api.py
# already enforces ``workspace:datasource:read`` for every graph route;
# write routes additionally require ``workspace:datasource:manage`` so a
# read-only workspace member cannot mutate the graph.
require_ws_manage = requires("workspace:datasource:manage", workspace="ws_id")


# ------------------------------------------------------------------ #
# Dependency: resolve ContextEngine for the active connection         #
# ------------------------------------------------------------------ #

async def get_context_engine(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID. Prefer workspace-scoped routes."),
    branchId: Optional[str] = Query(None, description="Opaque draft id (br_...) or 'main'. Omit to target main. Reads and writes both honor it."),
    # WS0.2 bulkhead: the ContextEngine holds this session for the whole
    # request, including the outbound FalkorDB call. Use the isolated
    # GRAPH_READ pool so a slow/down provider can't starve the WEB pool that
    # serves auth / navigation. Read-write (some graph endpoints reuse
    # engine._db_session for writes), so NOT the READONLY pool.
    session: AsyncSession = Depends(get_graph_read_db_session),
    user=Depends(get_optional_user),
) -> ContextEngine:
    """
    FastAPI dependency that resolves the appropriate ContextEngine.

    Priority:
    - `ws_id` (path param from /v1/{ws_id}/graph routes) → workspace-scoped engine
      - `dataSourceId` (optional query param) → targets specific data source within workspace
    - `connectionId` (query param, legacy) → connection-scoped engine
    - Neither → rejected; graph scope must be explicit

    Error boundary: ContextEngine.for_workspace/for_connection normalize
    all provider connectivity errors to ProviderUnavailable, which the
    global exception handler at main.py converts to HTTP 503 with
    Retry-After. KeyError (data source not found) becomes HTTP 404.
    """
    try:
        if ws_id:
            return await ContextEngine.for_workspace(
                ws_id, provider_manager, session, data_source_id=dataSourceId,
                actor=(user.id if user else None), branch_id=branchId,
            )
        if connectionId:
            return await ContextEngine.for_connection(connectionId, provider_manager, session)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    # ProviderUnavailable propagates to FastAPI exception handler → 503
    raise HTTPException(
        status_code=400,
        detail="scope_required: workspace_id or connection_id is required",
    )


@router.post("/bootstrap")
async def bootstrap_versioned_graph_endpoint(
    ws_id: str,
    dataSourceId: str = Query(..., description="Data source whose versioned graph to seed."),
    user=Depends(get_optional_user),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Seed the data source's versioned graph from the provider's current state so branches
    and history cover the whole graph. Idempotent — safe to re-run as a backfill.

    ATOMIC: create-graph + seed run in ONE transaction, so a failure never leaves a
    half-enabled graph (a graph row with no imported data). Provider reads happen first,
    outside the transaction."""
    from backend.app.services.versioning.service import GraphVersioningService
    actor = user.id if user else "system"
    svc = GraphVersioningService()
    # Seed-time canonicalization (Task E): if the source has an assigned ontology, pass
    # its rules so the bootstrap import writes OUR copy in canonical casing. None (no
    # assigned ontology) leaves source spellings untouched.
    ontology_rules = await _resolve_ontology_rules(engine)
    # Single idempotent enablement path: already-enabled → returns the graph untouched;
    # else create-graph + full provider import in ONE transaction (paging happens outside
    # it). Never leaves a half-enabled graph that would hijack reads while empty.
    return await svc.enable_versioning(
        data_source_id=dataSourceId, workspace_id=ws_id, actor=actor,
        provider=engine.provider, ontology_rules=ontology_rules)


@router.post("/resync")
async def resync_versioned_graph_endpoint(
    ws_id: str,
    dataSourceId: str = Query(..., description="Data source whose versioned graph to re-sync."),
    strategy: str = Query("merge", description="merge | external_wins"),
    user=Depends(get_optional_user),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Re-sync a versioned graph from its provider's CURRENT state on demand — runnable at
    any time for any versioned graph. 3-way merge preserves user edits (a field both the
    source and a user changed conflicts under ``merge``; pass ``external_wins`` to take the
    source). 404 if the data source isn't versioned yet (enable it first)."""
    from backend.app.services.versioning.service import GraphVersioningService
    actor = user.id if user else "system"
    svc = GraphVersioningService()
    res = await svc.resolve_graph(
        data_source_id=dataSourceId, actor=actor, workspace_id=ws_id, open_draft_if_absent=False)
    if res is None:
        raise HTTPException(status_code=404, detail="data source is not versioned; enable versioning first")
    return await svc.resync_from_provider(
        graph_id=res["graph_id"], provider=engine.provider, actor=actor, strategy=strategy)


@router.get("/vocab-alignment")
async def get_vocab_alignment(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source."),
    session: AsyncSession = Depends(get_db_session),
):
    """Per-source vocabulary-alignment drift for the DS panel warning (Task E). Cheap,
    DB-only read of the profile the canvas read path maintains — no provider call. When
    the source spells relationship/entity types differently than the ontology declares
    (``has`` vs ``HAS``), those are aligned automatically and reported here so the panel
    can say so in plain language. ``hasDrift=false`` (or a missing profile) → nothing to
    show."""
    import json as _json
    from backend.app.db.repositories.data_source_repo import get_data_source_orm
    from backend.app.db.repositories import ontology_source_mapping_repo as osm_repo
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id:
        raise HTTPException(status_code=400, detail="dataSourceId is required")
    ds = await get_data_source_orm(session, ds_id)
    ont_id = getattr(ds, "ontology_id", None) if ds else None
    row = await osm_repo.get_mapping(session, ds_id, ont_id)
    if row is None:
        return {"hasDrift": False, "driftDetails": [], "lastSeenAt": None}
    try:
        details = _json.loads(row.drift_details) if row.drift_details else []
    except (ValueError, TypeError):
        details = []
    return {"hasDrift": bool(row.has_drift), "driftDetails": details,
            "schemaHash": row.last_seen_schema_hash, "lastSeenAt": row.last_seen_at}


@router.post("/vocab-alignment/confirm")
async def confirm_vocab_variant(
    ws_id: Optional[str] = None,
    dataSourceId: str = Query(..., description="Data source whose variant decision to record."),
    declared: str = Query(..., description="The declared type id the variants merged into."),
    keepMerged: bool = Query(True, description="Keep the merge (true) or split into distinct types (false)."),
    dimension: str = Query("relationship", description="relationship | entity"),
    session: AsyncSession = Depends(get_db_session),
):
    """Record a user's Keep/Split decision for a same-source multi-variant type (Task E
    §1b). Reversible and never re-asked: the entry flips to explicit so auto-alignment
    won't overwrite it. Reads already used the proposed merge, so this only confirms or
    narrows it."""
    from backend.app.db.repositories.data_source_repo import get_data_source_orm
    from backend.app.db.repositories import ontology_source_mapping_repo as osm_repo
    ds = await get_data_source_orm(session, dataSourceId)
    ont_id = getattr(ds, "ontology_id", None) if ds else None
    row = await osm_repo.set_variant_decision(
        session, data_source_id=dataSourceId, ontology_id=ont_id,
        declared=declared, keep_merged=keepMerged, dimension=dimension)
    if row is None:
        raise HTTPException(status_code=404, detail="no alignment profile for this data source")
    await session.commit()
    # Alignment feeds the resolved-ontology alias maps — invalidate the
    # process-wide resolution cache so every pod re-derives on next read.
    from backend.app.services.resolved_ontology_cache import bump_ontology_generation
    await bump_ontology_generation(ws_id, dataSourceId)
    return {"declared": declared, "keepMerged": keepMerged, "hasDrift": bool(row.has_drift)}


# ------------------------------------------------------------------ #
# Helper: resolve data source ID from workspace (DB-only, no provider)#
# ------------------------------------------------------------------ #

def _cache_scope(engine: ContextEngine) -> Optional[CacheScope]:
    """Derive the (workspace, data source) scope for cache keys.

    Returns None when the engine has no workspace context (legacy
    connection-scoped path). Connection-scoped reads bypass the cache —
    they're vanishingly rare in production and not worth the extra key
    plumbing.
    """
    ws = getattr(engine, "_workspace_id", None)
    if not ws:
        return None
    ds = getattr(engine, "_data_source_id", None) or ""
    branch = getattr(engine, "_branch_id", None) or ""
    return CacheScope(workspace_id=ws, data_source_id=ds, branch_id=branch)


def _provider_health_header(engine: ContextEngine) -> str:
    """Map the engine's CircuitBreakerProxy state to the same string set
    used by the stats_cache envelope's ``provider_health`` field.

    Values mirror stats_cache: ``healthy`` | ``unreachable`` | ``unknown``.
    Half-open is reported as ``healthy`` because the breaker is actively
    probing — surfacing the transient state would flap the UI banner.
    """
    proxy = getattr(engine, "provider", None)
    state = getattr(proxy, "breaker_state", None)
    if state is None:
        return "unknown"
    if state == "open":
        return "unreachable"
    return "healthy"


async def _invalidate_cache(engine: ContextEngine) -> None:
    """Bump the generation counter for the engine's scope, invalidating
    every cached entry under (workspace, data_source).

    Safe to call after any write: missing scope is a no-op, Redis errors
    are swallowed by the cache layer. Never raises — invalidation
    failures must never fail the user's write."""
    scope = _cache_scope(engine)
    if scope is None:
        return
    await get_graph_cache().bump_generation(scope)
    # Graph content changed — nudge the insights counts poll so stats
    # reflect the write within seconds (cooldown-throttled, never
    # raises). Draft-branch writes are skipped: they don't touch the
    # main graph's stats until publish, which the versioning projection
    # covers with its own mark.
    if not getattr(scope, "branch_id", ""):
        await mark_stats_changed(scope.data_source_id, scope.workspace_id)


def _bounded_compute(engine: ContextEngine, compute):
    """Wrap a GraphCache ``compute`` callable in the per-(provider, graph)
    concurrency slot (``ProviderManager.acquire_provider_slot``, cap
    ``PROVIDER_MAX_CONCURRENCY``, default 8). Saturation raises
    ``ProviderBusy`` → 429 + Retry-After via the handler in main.py, so
    a burst of cache misses sheds load instead of pegging FalkorDB's
    single Cypher thread.

    Cache hits never touch the semaphore — only singleflight-leader
    misses do actual provider work. Engines whose provider doesn't
    expose ``manager_cache_key`` (draft/versioned wrappers that don't
    delegate attributes) degrade to unbounded — those paths are
    Postgres-overlay-heavy, not FalkorDB fan-out.
    """
    key = getattr(getattr(engine, "provider", None), "manager_cache_key", None)
    if key is None:
        return compute

    async def _run():
        sem = await provider_manager.acquire_provider_slot(*key)
        try:
            return await compute()
        finally:
            sem.release()

    return _run


async def _enforce_fair_share(engine: ContextEngine, endpoint: str) -> None:
    """Charge one token against the workspace's per-endpoint bucket.

    Raises :class:`ProviderBusy` (mapped to 429+Retry-After in main.py)
    when the bucket is empty. No-op when the fair-share feature flag is
    off OR the engine has no workspace context."""
    bucket = get_fair_share()
    if not bucket.is_enabled():
        return
    ws = getattr(engine, "_workspace_id", None)
    if not ws:
        return
    await bucket.enforce(endpoint, ws)


async def _resolve_data_source_id(
    session: AsyncSession,
    ws_id: Optional[str],
    data_source_id: Optional[str],
) -> Optional[str]:
    """Resolve the data source ID for a workspace without touching the provider.
    Returns the explicit data_source_id if given, otherwise looks up the primary
    data source for the workspace.  Returns None if nothing can be resolved.
    """
    if data_source_id:
        return data_source_id
    if not ws_id:
        return None
    from backend.app.db.repositories.data_source_repo import get_primary_data_source
    ds = await get_primary_data_source(session, ws_id)
    return ds.id if ds else None


# ------------------------------------------------------------------ #
# Graph endpoints                                                     #
# ------------------------------------------------------------------ #

# V1 trace sunset date — 2 weeks from the cutover. Update if the
# deprecation window changes. RFC 8594 Sunset header format.
_V1_TRACE_SUNSET = "Mon, 25 May 2026 00:00:00 GMT"


@router.post("/trace", response_model=None, response_model_by_alias=False, deprecated=True)
async def get_lineage_trace_deprecated(request: Request):
    """**REMOVED — V1 trace is no longer served.**

    The legacy ``/api/v1/{ws}/graph/trace`` endpoint backed by
    ``engine.get_lineage()`` was the slow path that timed out on 100k+
    node graphs. Skeleton-first replacement lives at
    ``POST /api/v2/{ws}/graph/trace`` and serves the top-level Domain
    skeleton in <100 ms.

    Clients during the 2-week deprecation window receive HTTP 410 with
    a ``Sunset`` header and a migration pointer. After the window the
    route is removed entirely.
    """
    client_host = request.client.host if request.client else "?"
    logger.warning(
        "v1_trace_deprecated called from %s — clients must migrate to "
        "POST /api/v2/{ws}/graph/trace",
        client_host,
    )
    return JSONResponse(
        status_code=410,
        headers={
            "Sunset": _V1_TRACE_SUNSET,
            "Deprecation": "true",
            "Link": '</api/v2/{ws_id}/graph/trace>; rel="successor-version"',
        },
        content={
            "error": {
                "code": "v1_trace_deprecated",
                "message": (
                    "POST /api/v1/{ws}/graph/trace has been removed. "
                    "Use POST /api/v2/{ws}/graph/trace — the skeleton-first "
                    "trace returns the top-level Domain skeleton by default "
                    "and supports lazy drill-down via /trace/expand."
                ),
                "details": {
                    "successor": "POST /api/v2/{ws_id}/graph/trace",
                    "sunset": _V1_TRACE_SUNSET,
                },
            },
        },
    )


# ----------------------------------------------------------------------------- #
# Trace v2 — Cypher-native, ontology-aware lineage                             #
#                                                                               #
# Companion to the legacy /trace endpoint above. Pushes all traversal +        #
# aggregation work into Cypher (per-hop set-based BFS), returns nodes already  #
# at the requested hierarchy level, supports drill-down via /trace/expand.     #
# Cost is proportional to result size, not graph size — safe for million-node  #
# graphs. See plan: /Users/.../plans/i-want-you-to-fluttering-badger.md         #
# ----------------------------------------------------------------------------- #


@router.post("/trace/v2", response_model=TraceResult, response_model_by_alias=True)
async def trace_v2(
    response: Response,
    request: TraceRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
) -> TraceResult:
    """Trace lineage at a hierarchy level using AGGREGATED edges.

    Returns nodes already at the requested level (peer rollup) plus the
    AGGREGATED edges between them. Filters by ``s.level``/``t.level`` at
    the database — never explodes a Domain-level trace down to Columns.

    Hard caps: ``TRACE_MAX_NODES`` (default 2000) nodes,
    ``TRACE_TIMEOUT_SECS`` (default 60 s) outer budget — both server
    config, not per-request. See ``app/config/resilience.py``. On trip,
    returns ``truncated: true`` with ``truncationReason``. Always HTTP
    200 unless input is malformed.
    """
    response.headers["X-Provider-Health"] = _provider_health_header(engine)

    async def compute() -> TraceResult:
        return await engine.trace(request)

    scope = _cache_scope(engine)
    if scope is None:
        return await compute()

    return await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_TRACE,
        # ``model_dump`` produces a deterministic dict keyed by field
        # name; the cache layer hashes it with ``sort_keys=True`` so
        # alias order / dict ordering can't shift the key.
        params=request.model_dump(mode="json", by_alias=True, exclude_none=True),
        compute=_bounded_compute(engine, compute),
        model_cls=TraceResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )


@router.post("/trace/expand", response_model=TraceResult, response_model_by_alias=True)
async def trace_expand(
    response: Response,
    request: ExpandRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
) -> TraceResult:
    """Drill into an AGGREGATED edge: return finer-level nodes + edges
    within (source-subtree × target-subtree) at ``nextLevel``.

    Set-based, no Cartesian. When ``nextLevel`` is the finest level in
    the ontology, the engine bypasses AGGREGATED and reads raw lineage
    edges directly.
    """
    response.headers["X-Provider-Health"] = _provider_health_header(engine)

    async def compute() -> TraceResult:
        return await engine.expand_aggregated_edge(request)

    scope = _cache_scope(engine)
    if scope is None:
        return await compute()

    return await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_TRACE_EXPAND,
        params=request.model_dump(mode="json", by_alias=True, exclude_none=True),
        compute=_bounded_compute(engine, compute),
        model_cls=TraceResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )


class _TraceExpandPair(BaseModel):
    """One aggregated-edge identifier in a batch expand. Aliases match the
    frontend payload (sourceUrn / targetUrn / nextLevel)."""
    source_urn: str = Field(alias="sourceUrn")
    target_urn: str = Field(alias="targetUrn")
    next_level: int | str = Field(alias="nextLevel")

    class Config:
        populate_by_name = True


class _TraceExpandBatchRequest(BaseModel):
    """Body for /trace/expand-batch — N edges share the same config."""
    pairs: List[_TraceExpandPair]
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    include_containment_edges: bool = Field(True, alias="includeContainmentEdges")

    class Config:
        populate_by_name = True


@router.post("/trace/expand-batch", response_model=TraceResult, response_model_by_alias=True)
async def trace_expand_batch(
    response: Response,
    request: _TraceExpandBatchRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
) -> TraceResult:
    """Batched drill-down. Replaces N concurrent POSTs to /trace/expand with
    one request — the frontend's ``autoDrillOnExpand`` collects every
    aggregated edge incident to an expanding traced node and ships them
    together. The server fans out via asyncio.gather and merges results by id.

    Partial-success: pair-level failures are swallowed (with a logged warning)
    so the rest of the batch returns; total failure returns 404 with the
    list of pair-level error messages in the response body. Shape matches
    /trace/expand so the frontend's normalizeTraceV2 handles either."""
    import asyncio
    if not request.pairs:
        # Empty batch — return an empty payload. Use the first pair's URN as
        # a placeholder focus; never reached because empty pairs short-circuit.
        raise HTTPException(status_code=400, detail="No pairs provided.")
    response.headers["X-Provider-Health"] = _provider_health_header(engine)

    pair_errors: List[str] = []

    async def run_one(p: _TraceExpandPair):
        req = ExpandRequest(
            source_urn=p.source_urn,
            target_urn=p.target_urn,
            next_level=p.next_level,
            lineage_edge_types=request.lineage_edge_types,
            include_containment_edges=request.include_containment_edges,
        )
        try:
            return await engine.expand_aggregated_edge(req)
        except Exception as exc:
            # Catch ALL exceptions per pair — provider unavailability, value
            # errors, missing URNs, etc. Surface to the response body so the
            # frontend can render a partial result with the failure list.
            msg = f"{p.source_urn} → {p.target_urn} @ {p.next_level}: {type(exc).__name__}: {exc}"
            pair_errors.append(msg)
            logger.warning("trace/expand-batch pair failed: %s", msg, exc_info=False)
            return None

    async def compute_batch() -> TraceResult:
        results = await asyncio.gather(*(run_one(p) for p in request.pairs))
        return _merge_expand_results(results, request, pair_errors)

    # Response-cached like the single /trace/expand (this handler used to
    # bypass GraphCache entirely, so every re-expand of the same drilled
    # pair set re-ran the full fan-out). Pairs are sorted into the cache
    # key so payload ordering doesn't fragment entries; gen-bump on writes
    # invalidates as usual.
    scope = _cache_scope(engine)
    if scope is None:
        return await compute_batch()
    cache_params = {
        "pairs": sorted(
            f"{p.source_urn}->{p.target_urn}@{p.next_level}"
            for p in request.pairs
        ),
        "lineageEdgeTypes": sorted(request.lineage_edge_types or []),
        "includeContainmentEdges": request.include_containment_edges,
    }
    return await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_TRACE_EXPAND,
        params=cache_params,
        compute=_bounded_compute(engine, compute_batch),
        model_cls=TraceResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )


def _merge_expand_results(results, request, pair_errors) -> TraceResult:
    successes = [r for r in results if r is not None]
    if not successes:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "trace_expand_batch_all_failed",
                "message": "No pair in the batch could be expanded.",
                "errors": pair_errors[:20],  # cap to keep response readable
            },
        )

    # Merge by id. Identical (s, t, lvl) triples produce deterministic results,
    # so last-write-wins is safe.
    nodes_by_id: dict = {}
    edges_by_id: dict = {}
    containment_by_id: dict = {}
    upstream_urns: set = set()
    downstream_urns: set = set()
    truncated_any = False
    focus = None
    effective_level = 0
    for r in successes:
        for n in r.nodes: nodes_by_id[n.urn] = n
        for e in r.edges: edges_by_id[e.id] = e
        for ce in r.containment_edges: containment_by_id[ce.id] = ce
        upstream_urns.update(r.upstream_urns)
        downstream_urns.update(r.downstream_urns)
        if r.truncated: truncated_any = True
        if focus is None:
            focus = r.focus
            effective_level = r.effective_level

    if pair_errors:
        logger.info(
            "trace/expand-batch partial success: %d/%d pairs succeeded",
            len(successes), len(request.pairs),
        )

    return TraceResult(
        nodes=list(nodes_by_id.values()),
        edges=list(edges_by_id.values()),
        containment_edges=list(containment_by_id.values()),
        upstream_urns=upstream_urns,
        downstream_urns=downstream_urns,
        focus=focus,
        effective_level=effective_level,
        truncated=truncated_any,
    )


@router.get(
    "/nodes/top-level",
    response_model=TopLevelNodesResult,
    response_model_by_alias=True,
)
async def get_top_level_nodes(
    response: Response,
    entityTypes: Optional[List[str]] = Query(
        None,
        description="Restrict to these entity type IDs. None = all types.",
    ),
    searchQuery: Optional[str] = Query(
        None,
        description="Case-insensitive substring match against displayName/urn.",
    ),
    limit: int = Query(100, ge=1, le=1000),
    cursor: Optional[str] = Query(
        None,
        description="Keyset cursor (displayName of the last node on the previous page).",
    ),
    includeChildCount: bool = Query(True, description="Populate child_count on each node."),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    """Return instances that have no incoming containment edge.

    "Top-level" is defined **structurally**: a node ``n`` is top-level iff
    there is no edge ``(n' -[:CONTAINMENT_EDGE]-> n)`` for any configured
    containment type. The result therefore mixes:
      - Instances of ontology root types (Domain, Platform, …)
      - Orphan instances of non-root types (e.g. a Table with no schema parent,
        perhaps from a broken or incremental import)

    The response's ``rootTypeCount`` and ``orphanCount`` fields let the UI
    distinguish the two classes (e.g. an "orphan" badge in the wizard tree).

    Containment edge types are resolved from the ontology bound to the active
    data source. If the ontology has no containment edges configured and no
    ``CONTAINMENT_EDGE_TYPES`` env override is present, the provider raises
    :class:`ProviderConfigurationError`, which is translated to HTTP 400 —
    the API must never silently fall back to hardcoded type names.

    **Route-ordering note.** This handler MUST be declared before
    ``/nodes/{urn}`` — FastAPI/Starlette matches routes in registration
    order, and the generic ``{urn}`` path would otherwise swallow
    ``/nodes/top-level`` and return 404 for a non-existent URN.
    """
    response.headers["X-Provider-Health"] = _provider_health_header(engine)

    scope = _cache_scope(engine)

    async def compute() -> TopLevelNodesResult:
        known_total = None
        if (
            scope is not None
            and not scope.branch_id            # main-branch physical reads only
            and scope.data_source_id
            and not searchQuery
            and not entityTypes
            and includeChildCount
        ):
            served, known_total = await try_serve_top_level(
                session, engine,
                ds_id=scope.data_source_id, ws_id=scope.workspace_id,
                limit=limit, cursor=cursor,
            )
            if served is not None:
                return served
        return await engine.get_top_level_or_orphan_nodes(
            entity_types=entityTypes,
            search_query=searchQuery,
            limit=limit,
            cursor=cursor,
            include_child_count=includeChildCount,
            known_total_count=known_total,
        )

    if scope is None:
        try:
            return await compute()
        except ProviderConfigurationError as exc:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Ontology configuration error: {exc}. Configure containment "
                    "edge types on the active ontology (or set CONTAINMENT_EDGE_TYPES "
                    "as a deployment-level override)."
                ),
            )

    try:
        return await get_graph_cache().get_or_compute(
            scope=scope,
            endpoint=ENDPOINT_TOP_LEVEL,
            params={
                "entityTypes": sorted(entityTypes) if entityTypes else None,
                "searchQuery": searchQuery,
                "limit": limit,
                "cursor": cursor,
                "includeChildCount": includeChildCount,
            },
            compute=_bounded_compute(engine, compute),
            model_cls=TopLevelNodesResult,
            on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
        )
    except ProviderConfigurationError as exc:
        # Logical error — not a cache-fallback case; surface as 400.
        raise HTTPException(
            status_code=400,
            detail=(
                f"Ontology configuration error: {exc}. Configure containment "
                "edge types on the active ontology (or set CONTAINMENT_EDGE_TYPES "
                "as a deployment-level override)."
            ),
        )


@router.get("/nodes/{urn}", response_model=GraphNode, response_model_by_alias=True)
async def get_node(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    node = await engine.get_node(urn)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


@router.get("/nodes/{urn}/parent", response_model=Optional[GraphNode], response_model_by_alias=True,
             deprecated=True)
async def get_node_parent(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get parent node (containment hierarchy).

    **Deprecated:** Use `GET /nodes/{urn}/ancestors?limit=1` instead.
    """
    logger.warning("Deprecated endpoint GET /nodes/%s/parent called — use GET /nodes/%s/ancestors?limit=1", urn, urn)
    return await engine.get_parent(urn)


@router.get("/nodes/{urn}/children", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_children(
    urn: str,
    edge_types: Optional[List[str]] = Query(None, alias="edgeTypes"),
    search_query: Optional[str] = Query(None, alias="searchQuery"),
    sort_property: Optional[str] = Query("displayName", alias="sortProperty", description="Node property to sort by. Pass null to skip sorting."),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    cursor: Optional[str] = Query(None, description="Cursor for keyset pagination (displayName of last item). Takes precedence over offset."),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Lazy load children nodes."""
    return await engine.get_children(urn, edge_types=edge_types, search_query=search_query, limit=limit, offset=offset, sort_property=sort_property, cursor=cursor)


@router.get("/nodes/{urn}/children-with-edges", response_model=ChildrenWithEdgesResult, response_model_by_alias=True)
async def get_children_with_edges(
    urn: str,
    response: Response,
    edge_types: Optional[List[str]] = Query(None, alias="edgeTypes"),
    lineage_edge_types: Optional[List[str]] = Query(None, alias="lineageEdgeTypes"),
    search_query: Optional[str] = Query(None, alias="searchQuery"),
    sort_property: Optional[str] = Query("displayName", alias="sortProperty", description="Node property to sort by. Pass null to skip sorting."),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    cursor: Optional[str] = Query(None, description="Cursor for keyset pagination (displayName of last item). Takes precedence over offset."),
    include_lineage_edges: bool = Query(True, alias="includeLineageEdges"),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get children with containment and lineage edges in a single round-trip."""
    await _enforce_fair_share(engine, ENDPOINT_CHILDREN)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)

    async def compute() -> ChildrenWithEdgesResult:
        return await engine.get_children_with_edges(
            urn, edge_types=edge_types, lineage_edge_types=lineage_edge_types,
            search_query=search_query, limit=limit, offset=offset,
            include_lineage_edges=include_lineage_edges,
            sort_property=sort_property, cursor=cursor,
        )

    scope = _cache_scope(engine)
    if scope is None:
        return await compute()

    return await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_CHILDREN,
        params={
            "urn": urn,
            "edgeTypes": sorted(edge_types) if edge_types else None,
            "lineageEdgeTypes": sorted(lineage_edge_types) if lineage_edge_types else None,
            "searchQuery": search_query,
            "sortProperty": sort_property,
            "limit": limit,
            "offset": offset,
            "cursor": cursor,
            "includeLineageEdges": include_lineage_edges,
        },
        compute=_bounded_compute(engine, compute),
        model_cls=ChildrenWithEdgesResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )


@router.post("/search", response_model=List[GraphNode], response_model_by_alias=True)
async def search_nodes(
    query: str = Body(..., embed=True),
    limit: int = Body(10, embed=True),
    offset: int = Body(0, embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.search_nodes(query, limit=limit, offset=offset)


def _map_validation_error(detail: str) -> HTTPException:
    """Map an AdvancedSearchService ValidationError detail string to the
    correct HTTP status code.

    The service signals view-scope failure modes via the message prefix
    (``view_not_found``, ``entity_type_not_in_view``, etc.) so the route
    layer can map to the right status without leaking the resolver's
    exception types into the HTTP surface.
    """
    if detail.startswith("view_not_found:"):
        return HTTPException(status_code=404, detail=detail)
    return HTTPException(status_code=400, detail=detail)


@router.post(
    "/search/advanced",
    response_model_by_alias=True,
)
async def search_advanced(
    query: SearchQuery,
    response: Response,
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None),
    branchId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    """Advanced server-side search, strictly scoped to ``scope.viewId``.

    Replaces the legacy ``POST /search`` with a structured predicate-tree
    request. Every search must be bound to a view via ``scope.viewId``;
    the server-side ``ViewScopeResolver`` enforces that searches never
    cross the view's boundary, regardless of what the client passes in
    ``scope.rootUrns``.

    Default response shape is per-ancestor *aggregates* (the "orient
    before drill" UX) — set ``options.results`` to ``'hits'`` or
    ``'both'`` for the flat list.

    When the client passes ``scope.rootUrns`` that lie outside the view,
    those URNs are dropped server-side; the count is surfaced via the
    ``X-Search-Dropped-URNs`` response header so the FE can log /
    diagnose.

    See ``backend/common/models/search.py`` for the full contract and
    ``docs/api/advanced-search.md`` for the AI-agent iterative-drill
    pattern.
    """
    if not ws_id:
        raise HTTPException(
            status_code=400,
            detail="workspace_id is required (path param ws_id)",
        )
    # Lazy imports keep this route free of overhead when feature isn't used.
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )
    svc = AdvancedSearchService(
        engine,
        session=session,
        workspace_id=ws_id,
        data_source_id=dataSourceId,
        branch_id=branchId,
    )
    try:
        page, eff_scope = await svc.search(query)
    except ValidationError as exc:
        raise _map_validation_error(str(exc)) from exc
    except NotImplementedError as exc:
        raise HTTPException(
            status_code=501,
            detail=(
                f"deep_search not implemented on the active provider "
                f"({type(engine.provider).__name__}). Only FalkorDB is "
                f"supported in this workstream."
            ),
        ) from exc

    if eff_scope.dropped_urns:
        response.headers["X-Search-Dropped-URNs"] = str(len(eff_scope.dropped_urns))
    response.headers["X-Search-Scope-Hash"] = eff_scope.scope_hash
    return page


@router.post("/search/explain")
async def search_explain(
    query: SearchQuery,
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None),
    branchId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    """Compile a SearchQuery without executing it.

    Returns the generated Cypher + bound parameters that
    ``search_advanced`` would run, plus the resolved-scope summary
    (``resolvedScope``) showing what URNs and entity types the view
    actually permits. Powers the dev panel's "Show Cypher" button and
    is the first stop for diagnosing queries that silently return 0
    results — most often the cause is "your view doesn't contain these
    URNs", which the resolved-scope summary makes obvious.

    Side-effect-free; safe to call repeatedly without rate-limit
    concerns.
    """
    if not ws_id:
        raise HTTPException(
            status_code=400,
            detail="workspace_id is required (path param ws_id)",
        )
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService, ValidationError,
    )
    svc = AdvancedSearchService(
        engine,
        session=session,
        workspace_id=ws_id,
        data_source_id=dataSourceId,
        branch_id=branchId,
    )
    try:
        return await svc.explain(query)
    except ValidationError as exc:
        raise _map_validation_error(str(exc)) from exc


@router.get("/search/discover")
async def search_discover(
    samplePerLabel: int = Query(
        200, ge=1, le=2000,
        description="How many nodes to sample per label before "
                    "collecting their distinct native property keys.",
    ),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Discover what native node properties exist in the active graph.

    Samples nodes per entity-type label and returns the set of native
    property keys present on them — the diagnostic counterpart to
    ``search_advanced``'s predicate compiler. Answers "what can I
    actually query?", which is the most common cause of property
    predicates returning 0 results (the user picks a key that doesn't
    exist on natively-stored nodes).

    A label with sampled > 0 nodes but zero user-keys appears in
    ``blobOnlyLabels`` — strong signal that those nodes are still on
    pre-W1 blob storage and need the migration script
    (``python -m backend.scripts.migrate_native_properties``) to be
    queryable by property.
    """
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )
    svc = AdvancedSearchService.for_diagnostics(engine)
    return await svc.discover(sample_per_label=samplePerLabel)


# Process-level cache of the SearchQuery JSON Schema. It's static
# within a release (Pydantic builds it from class definitions at import
# time), so compute once and reuse on every request.
_search_schema_cache: Optional[dict] = None
_search_schema_etag: Optional[str] = None


def _get_search_schema() -> tuple[dict, str]:
    """Compute (and memoise) the SearchQuery JSON Schema + a strong ETag."""
    global _search_schema_cache, _search_schema_etag
    if _search_schema_cache is None:
        from backend.common.models.search import SearchQuery
        schema = SearchQuery.model_json_schema(by_alias=True)
        body = json.dumps(schema, sort_keys=True, separators=(",", ":"))
        _search_schema_cache = schema
        _search_schema_etag = f'W/"{hashlib.sha256(body.encode()).hexdigest()[:16]}"'
    return _search_schema_cache, _search_schema_etag


@router.get("/search/schema")
async def search_schema(request: Request) -> Response:
    """Return the canonical SearchQuery JSON Schema.

    This endpoint is the runtime side of the JSON-DSL-as-source-of-truth
    contract. The FE fetches it once at boot, validates the served
    ``X-Schema-Version`` against the version of ``@synodic/search-schema``
    it was built against, and uses the schema to drive Ajv validation
    in the JSON editor. AI agents and external integrations consume
    the same shape.

    The schema is published as a versioned npm artifact via a separate
    CI step (see ``backend/scripts/export_search_schema.py``); this
    runtime endpoint is the source of truth at request time.
    """
    from backend.common.models.search import SCHEMA_VERSION
    schema, etag = _get_search_schema()
    # Conditional-GET support — schemas almost never change within a
    # release, so a long-lived 304 is fine.
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "X-Schema-Version": SCHEMA_VERSION,
                "Cache-Control": "public, max-age=300",
            },
        )
    return JSONResponse(
        content=schema,
        headers={
            "ETag": etag,
            "X-Schema-Version": SCHEMA_VERSION,
            "Cache-Control": "public, max-age=300",
        },
    )


@router.get("/edges", response_model=List[GraphEdge], response_model_by_alias=True,
             deprecated=True)
async def get_edges(
    edge_type: Optional[str] = Query(None, alias="edgeType"),
    source_urn: Optional[str] = Query(None, alias="sourceUrn"),
    target_urn: Optional[str] = Query(None, alias="targetUrn"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic edge query.

    **Deprecated:** Use `POST /edges/query` instead — supports bulk URN lists and complex filters.
    """
    logger.warning("Deprecated endpoint GET /edges called — use POST /edges/query")
    q = EdgeQuery(offset=offset, limit=limit)
    if edge_type:
        q.edge_types = [edge_type]
    if source_urn:
        q.source_urns = [source_urn]
    if target_urn:
        q.target_urns = [target_urn]
    return await engine.get_edges(q)


@router.get("/map/{urn}")
async def get_neighborhood_map(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get node and its immediate edges."""
    result = await engine.get_neighborhood(urn)
    if not result:
        raise HTTPException(status_code=404, detail="Node not found")
    return result


@router.get("/stats", deprecated=True)
async def get_graph_stats(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """**Deprecated:** Use `GET /introspection` instead — returns a superset of stats with full schema details.

    Cache-only read: serves the latest ``data_source_stats`` row populated
    by the stats service. The handler never calls the provider, so it
    cannot 504 regardless of graph size. Always returns HTTP 200 with
    the canonical ``{data, meta}`` envelope; cache state lives in
    ``meta.status``.
    """
    logger.warning("Deprecated endpoint GET /stats called — use GET /introspection")

    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id:
        raise HTTPException(status_code=400, detail="dataSourceId is required")

    try:
        data, meta = await read_stats_cache(session, ds_id, ws_id, "node_stats")
        return JSONResponse(content=build_envelope(data, meta))
    except CacheMiss:
        pass
    except (OperationalError, SQLAlchemyError) as exc:
        logger.warning("get_graph_stats: database unavailable (ds_id=%s): %s", ds_id, exc)
        return JSONResponse(content=build_error_envelope(ds_id, reason="db_unavailable"))

    msg_id = await enqueue_stats_job_safe(ds_id, ws_id) if ws_id else None
    logger.info("stats_cache.served_computing endpoint=/graph/stats ds_id=%s msg_id=%s", ds_id, msg_id)
    return JSONResponse(content=build_computing_envelope(ds_id, ws_id, msg_id))


@router.get("/nodes", response_model=List[GraphNode], response_model_by_alias=True,
             deprecated=True)
async def get_nodes(
    entity_type: Optional[str] = Query(None, alias="entityType"),
    tag: Optional[str] = Query(None),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic node query.

    **Deprecated:** Use `POST /nodes/query` instead — supports complex filters and bulk operations.
    """
    logger.warning("Deprecated endpoint GET /nodes called — use POST /nodes/query")
    q = NodeQuery(
        entity_types=[entity_type] if entity_type else None,
        tags=[tag] if tag else None,
        limit=limit,
        offset=offset,
    )
    return await engine.get_nodes_query(q)


@router.get("/nodes/{urn}/ancestors", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_ancestors(
    urn: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.get_ancestors(urn, limit=limit, offset=offset)


@router.get("/nodes/{urn}/descendants", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_descendants(
    urn: str,
    depth: int = Query(5, ge=1),
    entity_type: Optional[str] = Query(None, alias="entityType"),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    entity_types = [entity_type] if entity_type else None
    return await engine.get_descendants(urn, depth=depth, entity_types=entity_types, limit=limit, offset=offset)


@router.get("/nodes/by-tag/{tag}", response_model=List[GraphNode], response_model_by_alias=True,
             deprecated=True)
async def get_nodes_by_tag_endpoint(
    tag: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    """**Deprecated:** Use `POST /nodes/query` with `tags` filter instead."""
    logger.warning("Deprecated endpoint GET /nodes/by-tag/%s called — use POST /nodes/query with tags filter", tag)
    return await engine.get_nodes_by_tag(tag, limit=limit, offset=offset)


@router.get("/nodes/by-layer/{layer_id}", response_model=List[GraphNode], response_model_by_alias=True)
async def get_nodes_by_layer_endpoint(
    layer_id: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.get_nodes_by_layer(layer_id, limit=limit, offset=offset)


class InternalEdgeQuery(BaseModel):
    """Fetch edges where BOTH source and target are in the provided URN set."""
    urns: List[str]
    edge_types: Optional[List[str]] = Field(None, alias="edgeTypes")
    limit: int = Field(
        default_factory=lambda: int(os.getenv("INTERNAL_EDGE_QUERY_LIMIT_DEFAULT", "50000")),
        le=200000,
    )
    class Config:
        populate_by_name = True


class _EdgeListResult(RootModel[List[GraphEdge]]):
    """RootModel wrapper so GraphCache can serialize the bare-list responses
    of /edges/between and /edges/query."""


class _NodeListResult(RootModel[List[GraphNode]]):
    """RootModel wrapper for /nodes/query's bare-list response."""


@router.post("/edges/between", response_model=List[GraphEdge], response_model_by_alias=True)
async def get_edges_between(
    response: Response,
    query: InternalEdgeQuery = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Fetch edges where both source and target are in the URN set.

    Uses source_urns + target_urns AND-semantics in the Cypher query so only
    edges connecting nodes within the set are returned — no over-fetch or
    Python post-filter needed.

    Response-cached (gen-bump invalidated) AND slot-bounded: the heaviest
    hydration query (an AND-scan over the loaded set) now serves repeat
    canvas opens from Redis, and a cold-open burst still sheds with 429
    (via ``_bounded_compute``) rather than piling onto FalkorDB.
    """
    async def compute() -> _EdgeListResult:
        edges = await engine.get_edges(EdgeQuery(
            source_urns=query.urns,
            target_urns=query.urns,
            edge_types=query.edge_types,
            limit=query.limit,
        ))
        return _EdgeListResult(edges)

    scope = _cache_scope(engine)
    if scope is None:
        return (await _bounded_compute(engine, compute)()).root
    result = await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_EDGES_BETWEEN,
        params={
            "urns": sorted(query.urns),
            "edgeTypes": sorted(query.edge_types) if query.edge_types else None,
            "limit": query.limit,
        },
        compute=_bounded_compute(engine, compute),
        model_cls=_EdgeListResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )
    return result.root


@router.post("/edges/query", response_model=List[GraphEdge], response_model_by_alias=True)
async def query_edges(
    query: EdgeQuery = Body(..., embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Advanced edge query (bulk fetch)."""
    return await engine.get_edges(query)


@router.post("/nodes/query", response_model=List[GraphNode], response_model_by_alias=True)
async def query_nodes(
    response: Response,
    query: NodeQuery = Body(..., embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Advanced node query (bulk fetch, complex filters). Response-cached
    (gen-bump invalidated) + slot-bounded — fired on every canvas
    hydration; repeat opens now serve from Redis, cold bursts shed 429."""
    async def compute() -> _NodeListResult:
        return _NodeListResult(await engine.get_nodes_query(query))

    scope = _cache_scope(engine)
    if scope is None:
        return (await _bounded_compute(engine, compute)()).root
    result = await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_NODES_QUERY,
        params=query.model_dump(mode="json", by_alias=True, exclude_none=True),
        compute=_bounded_compute(engine, compute),
        model_cls=_NodeListResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )
    return result.root


@router.get("/metadata/entity-types", response_model=List[str])
async def get_entity_types(
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get distinct entity types in the graph."""
    values = await engine.get_distinct_values("entityType")
    return [str(v) for v in values]


@router.get("/metadata/tags", response_model=List[str])
async def get_tags(
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get distinct tags in the graph."""
    values = await engine.get_distinct_values("tags")
    return [str(v) for v in values]


@router.get("/metadata/distinct/{property}")
async def get_distinct_values(
    property: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic endpoint to get distinct values for filters."""
    return await engine.get_distinct_values(property)


class SaveGraphRequest(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]


@router.post("/save")
async def save_graph(
    request: SaveGraphRequest,
    engine: ContextEngine = Depends(get_context_engine),
    _: object = Depends(require_ws_manage),
):
    """Save custom graph nodes and edges."""
    success = await engine.save_custom_graph(request.nodes, request.edges)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save graph")
    await _invalidate_cache(engine)
    return {"status": "success", "message": "Graph saved successfully"}


# ``_freshness_headers`` previously lived here. It now lives in
# :mod:`backend.app.services.stats_cache` where it is emitted directly
# from :func:`read_stats_cache` alongside the cache tier classification
# and stats-service health signals — keeping header construction next
# to the read path prevents drift between what the cache says and what
# the response advertises.


@router.get("/introspection")
async def get_graph_introspection(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """Get detailed schema statistics for the graph.

    Cache-only read: serves the latest ``data_source_stats.schema_stats``
    row populated by the stats service. Always returns HTTP 200 with
    the canonical ``{data, meta}`` envelope; ``meta.status`` carries
    cache state (``fresh``/``stale``/``computing``). The handler never
    calls the provider; 504s are impossible by construction.
    """
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id:
        raise HTTPException(status_code=400, detail="dataSourceId is required")

    try:
        data, meta = await read_stats_cache(session, ds_id, ws_id, "schema_stats")
        return JSONResponse(content=build_envelope(data, meta))
    except CacheMiss:
        pass
    except (OperationalError, SQLAlchemyError) as exc:
        logger.warning("get_graph_introspection: database unavailable (ds_id=%s): %s", ds_id, exc)
        return JSONResponse(content=build_error_envelope(ds_id, reason="db_unavailable"))

    msg_id = await enqueue_stats_job_safe(ds_id, ws_id) if ws_id else None
    logger.info("stats_cache.served_computing endpoint=/introspection ds_id=%s msg_id=%s", ds_id, msg_id)
    return JSONResponse(content=build_computing_envelope(ds_id, ws_id, msg_id))


@router.get("/metadata/ontology", deprecated=True)
async def get_ontology_metadata(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """Get ontology metadata including containment edge types and entity hierarchies.

    **Deprecated:** Use `GET /metadata/schema` instead — returns a superset including ontology, entity types, and relationship definitions.

    Cache-only read with ``{data, meta}`` envelope, always HTTP 200.
    """
    logger.warning("Deprecated endpoint GET /metadata/ontology called — use GET /metadata/schema")

    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id:
        raise HTTPException(status_code=400, detail="dataSourceId is required")

    try:
        data, meta = await read_stats_cache(session, ds_id, ws_id, "ontology_metadata")
        return JSONResponse(
            content=build_envelope(data, meta),
            headers={"Cache-Control": "private, max-age=300"},
        )
    except CacheMiss:
        pass
    except (OperationalError, SQLAlchemyError) as exc:
        logger.warning("get_ontology_metadata: database unavailable (ds_id=%s): %s", ds_id, exc)
        return JSONResponse(content=build_error_envelope(ds_id, reason="db_unavailable"))

    msg_id = await enqueue_stats_job_safe(ds_id, ws_id) if ws_id else None
    logger.info("stats_cache.served_computing endpoint=/metadata/ontology ds_id=%s msg_id=%s", ds_id, msg_id)
    return JSONResponse(content=build_computing_envelope(ds_id, ws_id, msg_id))


def _schema_etag(payload: dict, *, status: str, source: str) -> str:
    """Compute a weak ETag over the canonical schema payload + state markers.

    The ETag input includes ``meta.status`` and ``meta.source`` because
    those signal a semantic transition the client must observe — e.g. a
    synthetic schema (``status=partial``, ``source=ontology``) replaced
    by the real schema (``status=fresh``, ``source=postgres``) that
    happens to be byte-identical (empty graph case). Without status/
    source in the ETag, the client would 304 on the transition, never
    update its banner, and stay stuck on "partial" forever.

    ``updated_at`` is intentionally excluded — it changes every poll
    and would make 304s impossible. Cache freshness boundary crossings
    (fresh→stale) DO change ``status``, so they correctly invalidate.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    seed = f"{status}|{source}|{canonical}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return f'W/"{digest}"'


def _schema_response(
    data: Optional[dict], request: Request, *, meta: dict,
) -> Response:
    """Build the envelope response for /metadata/schema with ETag handling.

    The envelope is ``{"data": data, "meta": meta}``. The ETag is
    computed over ``data`` plus ``meta.status`` and ``meta.source`` —
    so transitions that swap the *meaning* of an otherwise-identical
    payload (synthetic → real, fresh → stale) correctly invalidate the
    client's cached copy. ``meta.updated_at`` is excluded so steady-
    state polls within the same tier still benefit from 304s.
    """
    headers: dict[str, str] = {
        "Cache-Control": "private, max-age=0, must-revalidate",
    }
    if data is not None:
        etag = _schema_etag(data, status=meta.get("status", ""), source=meta.get("source", ""))
        headers["ETag"] = etag
        if_none_match = request.headers.get("if-none-match")
        if if_none_match and if_none_match == etag:
            return Response(status_code=304, headers=headers)
    return JSONResponse(content=build_envelope(data, meta), headers=headers)


@router.get("/metadata/schema")
async def get_graph_schema(
    request: Request,
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Get complete graph schema including entity types, relationship types,
    visual configurations, and hierarchy rules.
    This enables frontend to dynamically load schema from backend.

    Cache-first: reads the latest ``data_source_stats.graph_schema`` row
    populated by the stats service. On miss, serves a synthetic schema
    built from the data source's assigned ontology (zero entity counts,
    but correct types/relationships — canvas renders immediately while
    the real schema computes in the background; ``meta.status=partial``,
    ``meta.source=ontology``). If there is no ontology assigned either,
    returns ``meta.status=computing`` with a pollable jobId.

    Always HTTP 200. ``data`` carries the schema (or null when
    computing); ``meta`` carries cache state.

    A weak ETag is computed over ``data`` so clients that re-fetch with
    ``If-None-Match`` get a 304 — saves re-parsing unchanged schemas
    while ``meta`` still updates freshness on every read.
    """
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id:
        raise HTTPException(status_code=400, detail="dataSourceId is required")

    try:
        data, meta = await read_stats_cache(session, ds_id, ws_id, "graph_schema")
        return _schema_response(data, request, meta=meta)
    except CacheMiss:
        pass
    except (OperationalError, SQLAlchemyError) as exc:
        logger.warning("get_graph_schema: database unavailable (ds_id=%s): %s", ds_id, exc)
        return JSONResponse(content=build_error_envelope(ds_id, reason="db_unavailable"))

    # Cache miss: enqueue a real refresh in the background regardless of
    # whether synthetic schema rendered, so the frontend's poll hook
    # auto-upgrades from synthetic to real when the worker completes.
    msg_id = await enqueue_stats_job_safe(ds_id, ws_id) if ws_id else None
    job_id = msg_id or f"dedup:{ds_id}"
    poll_url = f"/api/v1/{ws_id}/graph/introspection/refresh/{job_id}" if ws_id else None

    synthetic = await build_synthetic_schema(session, ds_id)
    if synthetic:
        logger.info("stats_cache.served_synthetic endpoint=/metadata/schema ds_id=%s", ds_id)
        meta = build_meta(
            status="partial",
            source="ontology",
            data_source_id=ds_id,
            missing_fields=SYNTHETIC_SCHEMA_MISSING_FIELDS,
            refreshing=True,
            job_id=job_id,
            poll_url=poll_url,
        )
        return _schema_response(synthetic, request, meta=meta)

    logger.info("stats_cache.served_computing endpoint=/metadata/schema ds_id=%s msg_id=%s", ds_id, msg_id)
    return JSONResponse(content=build_computing_envelope(
        ds_id, ws_id, msg_id, missing_fields=SYNTHETIC_SCHEMA_MISSING_FIELDS,
    ))


# ── Async introspection refresh ──────────────────────────────────────
# On large graphs (1M+ nodes/edges), a live introspection can take
# minutes. The background stats service keeps the Postgres cache fresh
# on a 5-minute interval. This endpoint enqueues an on-demand refresh
# job onto the stats-service Redis stream (``stats.jobs``) so the actual
# work runs on the stats-worker thread pool with its own 600s timeout
# budget — not on a FastAPI request thread where it would race against
# ``HTTP_TIMEOUT_GRAPH_SECS``.
#
# Dedup: the stats service's Redis SET-NX claim prevents duplicate work
# when the scheduler and the user-triggered refresh collide on the same
# data source. Callers that lose the dedup race get ``status=
# already_computing`` with a deterministic jobId; they poll the same
# status endpoint regardless.


@router.post("/introspection/refresh")
async def refresh_introspection(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db_session),
    _: object = Depends(require_ws_manage),
):
    """Trigger a non-blocking refresh of the schema/introspection cache.

    Pushes a job onto the stats-service Redis stream ``stats.jobs``.
    The stats worker — which owns the only code path allowed to
    introspect the provider — picks it up within seconds.

    Always HTTP 200 with the canonical ``{data, meta}`` envelope.
    ``meta.status="computing"`` regardless of whether we won the
    ``try_claim`` race; the caller polls the status endpoint identically
    either way and observes completion via ``data_source_stats.updated_at``.
    """
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id or not ws_id:
        raise HTTPException(status_code=400, detail="ws_id and dataSourceId required")

    # Force path: the user explicitly clicked Refresh — a stale dedup
    # claim from a crashed worker must not turn that into a silent no-op
    # for up to the claim TTL.
    msg_id = await enqueue_stats_job_force(ds_id, ws_id)
    logger.info(
        "stats_cache.refresh_trigger ds_id=%s msg_id=%s outcome=%s",
        ds_id, msg_id, "enqueued" if msg_id else "dedup_or_redis_down",
    )
    return build_computing_envelope(ds_id, ws_id, msg_id)


@router.get("/introspection/refresh/{job_id}")
async def get_refresh_status(
    job_id: str,
    dataSourceId: Optional[str] = Query(None, description="Data source ID for completion inference."),
    since: Optional[str] = Query(None, description="ISO timestamp the caller considers the job 'started at'. A later cache updated_at proves completion."),
    session: AsyncSession = Depends(get_db_session),
):
    """Poll refresh status by comparing ``data_source_stats.updated_at``.

    The stats service does not track individual job lifecycles — it just
    upserts the cache row on completion. We infer completion: if the
    cache row's ``updated_at`` is newer than the ``since`` timestamp
    the caller sent, the job has completed.

    Returns the canonical ``{data, meta}`` envelope. ``meta.status`` is
    one of:

    * ``fresh`` — cache row exists and (when ``since`` provided)
                  ``updated_at > since`` proves the requested job finished
    * ``computing`` — no row yet, or ``updated_at`` not advanced past ``since``
    * ``error`` — DB unavailable
    """
    from backend.app.db.repositories.stats_repo import get_data_source_stats

    if not dataSourceId:
        return build_envelope(
            None,
            build_meta(
                status="error", source="error",
                data_source_id="",
                missing_fields=["dataSourceId_query_param_required"],
                job_id=job_id,
            ),
        )

    try:
        cache = await get_data_source_stats(session, dataSourceId)
    except (OperationalError, SQLAlchemyError) as exc:
        logger.warning("get_refresh_status: database unavailable (ds_id=%s): %s", dataSourceId, exc)
        return build_envelope(
            None,
            build_meta(
                status="error", source="error",
                data_source_id=dataSourceId,
                missing_fields=["db_unavailable"],
                job_id=job_id,
            ),
        )

    completed = False
    if since and cache and cache.updated_at:
        try:
            since_dt = datetime.fromisoformat(since)
            if since_dt.tzinfo is None:
                since_dt = since_dt.replace(tzinfo=timezone.utc)
            updated_dt = datetime.fromisoformat(cache.updated_at)
            if updated_dt.tzinfo is None:
                updated_dt = updated_dt.replace(tzinfo=timezone.utc)
            completed = updated_dt > since_dt
        except (ValueError, TypeError):
            completed = False

    if completed:
        return build_envelope(
            None,
            build_meta(
                status="fresh", source="postgres",
                data_source_id=dataSourceId,
                age_seconds=0, ttl_seconds=None,
                refreshing=False, job_id=job_id,
                updated_at=cache.updated_at if cache else None,
            ),
        )

    return build_envelope(
        None,
        build_meta(
            status="computing", source="none",
            data_source_id=dataSourceId,
            refreshing=True, job_id=job_id,
            updated_at=cache.updated_at if cache else None,
        ),
    )


@router.post("/edges/aggregated", response_model=AggregatedEdgeResult, response_model_by_alias=True)
async def get_aggregated_edges(
    response: Response,
    request: AggregatedEdgeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Get aggregated edges between containers.
    Returns summarized edge information showing lineage connections
    at a higher granularity level (e.g., between datasets instead of columns).
    """
    await _enforce_fair_share(engine, ENDPOINT_AGGREGATED)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)

    async def compute() -> AggregatedEdgeResult:
        return await engine.get_aggregated_edges(request)

    scope = _cache_scope(engine)
    if scope is None:
        return await compute()

    # Sort URN lists so two semantically identical requests with differing
    # input order map to the same cache key — the frontend's chunked
    # fan-out frequently produces equivalent batches in different orders.
    return await get_graph_cache().get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_AGGREGATED,
        params={
            "sourceUrns": sorted(request.source_urns or []),
            "targetUrns": sorted(request.target_urns or []) if request.target_urns else None,
            "granularity": request.granularity,
            "includeEdgeTypes": sorted(request.include_edge_types or []) if request.include_edge_types else None,
            "lineageEdgeTypes": sorted(request.lineage_edge_types or []) if request.lineage_edge_types else None,
            "containmentEdgeTypes": sorted(request.containment_edge_types or []) if request.containment_edge_types else None,
        },
        compute=_bounded_compute(engine, compute),
        model_cls=AggregatedEdgeResult,
        on_stale=lambda: response.headers.__setitem__("X-Cache-Status", "stale-fallback"),
    )


@router.post("/edges/aggregated/materialize")
async def materialize_aggregated_edges(
    engine: ContextEngine = Depends(get_context_engine),
    batch_size: int = Body(1000, embed=True),
    _: object = Depends(require_ws_manage),
):
    """
    Trigger batch materialization of AGGREGATED edges.
    Scans all lineage edges and creates/updates [:AGGREGATED] relationships
    between ancestor pairs at equivalent hierarchy levels.

    This should be run after data ingestion or as a periodic maintenance task.
    """
    ontology = await engine.get_ontology_metadata()
    try:
        stats = await engine.materialize_aggregated_edges(
            batch_size=batch_size,
            containment_edge_types=list(ontology.containment_edge_types),
            lineage_edge_types=list(ontology.lineage_edge_types),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return JSONResponse(content=stats)


@router.post("/nodes/create", response_model=CreateNodeResult, response_model_by_alias=True)
async def create_node(
    request: CreateNodeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
    _: object = Depends(require_ws_manage),
):
    """
    Create a new node with optional containment edge.
    If parentUrn is provided, automatically creates a CONTAINS edge
    based on ontology rules.
    """
    result = await engine.create_node(request)
    await _invalidate_cache(engine)
    return result


# ─── Edge CRUD ────────────────────────────────────────────────────────────────

@router.post("/edges", response_model=EdgeMutationResult, response_model_by_alias=True, status_code=201)
async def create_edge(
    request: CreateEdgeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
    _: object = Depends(require_ws_manage),
):
    """
    Create a directed edge between two existing nodes.

    Validates source/target entity types against the active ontology.
    If idempotencyKey is supplied and a matching edge already exists it is returned unchanged.
    """
    result = await engine.create_edge(request)
    await _invalidate_cache(engine)
    return result


@router.patch("/edges/{edge_id}", response_model=EdgeMutationResult, response_model_by_alias=True)
async def update_edge(
    edge_id: str,
    request: UpdateEdgeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
    _: object = Depends(require_ws_manage),
):
    """Update mutable properties of an existing edge. Edge type is immutable."""
    result = await engine.update_edge(edge_id, request)
    await _invalidate_cache(engine)
    return result


@router.delete("/edges/{edge_id}", status_code=204)
async def delete_edge(
    edge_id: str,
    engine: ContextEngine = Depends(get_context_engine),
    _: object = Depends(require_ws_manage),
):
    """Delete an edge by ID."""
    success = await engine.delete_edge(edge_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Edge '{edge_id}' not found")
    await _invalidate_cache(engine)


# ─── Draft batch write (atomic, server-merged) ──────────────────────────────

async def _resolve_containment_types(engine: ContextEngine) -> List[str]:
    """The CURRENT ontology's containment edge types (resolved live, 5-min cached on the
    engine — never a stored snapshot, never hardcoded), driving the delete cascade. Empty
    on failure → the cascade degrades to the node + its own incident edges (no descendant
    discovery), which is safe."""
    try:
        meta = await engine.get_ontology_metadata()
        return list(getattr(meta, "containment_edge_types", None) or [])
    except Exception:
        return []


async def _resolve_ontology_rules(engine: ContextEngine, *, fail_closed: bool = False):
    """Rich commit-boundary rules (``OntologyRules``) from the engine's cached resolved
    ontology — only when the data source has an *explicitly assigned* ontology (the
    system-default/introspection fallback layers must not retroactively gate legacy
    graphs). Best-effort ``None`` on failure, unless ``fail_closed`` (blank graphs are
    contractually ontology-governed — a write whose rules can't be resolved must not
    slip through unvalidated)."""
    try:
        from backend.app.db.repositories.data_source_repo import get_data_source_orm
        from backend.app.ontology.rules import resolved_ontology_to_rules
        # The engine keeps its scope private; this app-layer helper is the one sanctioned
        # reader (it built the engine from the same request session).
        ds_id, session = engine._data_source_id, engine._db_session
        if not ds_id or session is None:
            return None
        ds = await get_data_source_orm(session, ds_id)
        if ds is None or not ds.ontology_id:
            if fail_closed:
                raise HTTPException(status_code=422, detail={
                    "type": "ontology_required",
                    "message": "This graph is ontology-governed but its data source has no "
                               "assigned ontology; assign one to resume editing."})
            return None
        resolved = await engine._resolve_ontology()
        return resolved_ontology_to_rules(resolved)
    except HTTPException:
        raise
    except Exception:
        logger.exception("ontology-rules resolution failed for /graph/changes")
        if fail_closed:
            raise HTTPException(status_code=503, detail={
                "type": "ontology_unavailable",
                "message": "The ontology for this graph could not be resolved; writes are "
                           "blocked until it is available again."})
        return None


class GraphChangeOp(BaseModel):
    """One typed change in a draft save. ``update`` payloads are *partial* — the
    server merges them onto the entity's current state, so the client never has to
    reload (and risk clobbering) fields it didn't edit."""
    op: str = Field(description="create | update | delete")
    kind: str = Field(description="node | edge")
    id: Optional[str] = Field(default=None, description="entity id / urn (update/delete, or an explicit create id)")
    ref: Optional[str] = Field(default=None, description="client temp ref → echoed back in `assigned` for creates")
    payload: Optional[dict] = None
    base_version: Optional[str] = Field(
        default=None, alias="baseVersion",
        description="optimistic-concurrency token: the `version` (content hash) the client read for "
        "this entity. When present on an update, the server 3-way merges so a concurrent same-field "
        "edit raises a conflict instead of silently overwriting. Absent ⇒ plain patch (no OCC).")

    class Config:
        populate_by_name = True


class GraphChangesRequest(BaseModel):
    ops: List[GraphChangeOp]
    message: Optional[str] = None


class GraphChangesResponse(BaseModel):
    commit_id: Optional[str] = Field(default=None, alias="commitId")
    assigned: dict = Field(default_factory=dict)

    class Config:
        populate_by_name = True


def _resolve_change_ops(request_ops, mint_id, mint_urn):
    """Translate a batch of canvas edit ops into ONE ``apply_ops`` op list. Two passes so creates AND
    the edges/updates/layer-moves that reference those fresh nodes (by a temp ``ref``) commit together
    as a SINGLE atomic commit — instead of one commit per create. Pass 1 assigns a real id to every
    create (a NODE's id IS its urn — minted via ``mint_urn`` when the collapsed save omits it, exactly
    like ``/nodes/create``; an edge gets a plain minted id) and builds the ``ref → id`` map; pass 2
    emits the ops, resolving temp refs in edge endpoints + update/delete target ids and stamping the
    node urn into its payload. Returns ``(ops, assigned)`` — ``assigned`` (ref/id → real id) is echoed
    to the client to reconcile its optimistic ids. apply_ops validates same-batch edges against these
    creates (proved in ``test_versioning_batch_create_edge``)."""
    endpoint_fields = ("sourceEntityId", "source_entity_id", "targetEntityId", "target_entity_id")
    assigned: dict = {}
    create_eid: dict = {}                      # op index → its assigned real id (reused in pass 2)
    for i, o in enumerate(request_ops):
        if o.op == "create":
            if o.kind == "edge":
                eid = o.id or mint_id("ent")
            else:                              # a NODE's entity_id IS its urn (versioned-graph model);
                pl = o.payload or {}           # mint one when the collapsed save omits it.
                eid = pl.get("urn") or o.id or mint_urn(str(pl.get("entityType") or "entity"))
            create_eid[i] = eid
            if o.ref:
                assigned[o.ref] = eid
            assigned.setdefault(eid, eid)

    def _ref(x):                               # temp ref → real id; pass real ids / non-strings through
        return assigned.get(x, x) if isinstance(x, str) else x

    ops: List[dict] = []
    for i, o in enumerate(request_ops):
        kind = "edge" if o.kind == "edge" else "node"
        if o.op == "delete":
            if not o.id:
                continue
            ops.append({"op": "delete", "entity_kind": kind, "entity_id": _ref(o.id), "payload": None})
        elif o.op == "create":
            eid = create_eid[i]
            payload = dict(o.payload or {})
            if kind == "edge":                 # an edge may point at nodes created in THIS same batch
                for f in endpoint_fields:
                    if f in payload:
                        payload[f] = _ref(payload[f])
            else:                              # node — stamp the (minted-or-given) urn into the payload
                payload["urn"] = eid
            ops.append({"op": "create", "entity_kind": kind, "entity_id": eid, "payload": payload})
        else:  # update — forward the RAW partial patch + the OCC base_version; the service does the
               # authoritative field-level merge (patch onto current, or a 3-way conflict check).
            if not o.id:
                continue
            ops.append({"op": "update", "entity_kind": kind, "entity_id": _ref(o.id),
                        "payload": o.payload or {}, "base_version": o.base_version})
    return ops, assigned


@router.post("/changes", response_model=GraphChangesResponse, response_model_by_alias=True)
async def apply_graph_changes(
    ws_id: str,
    request: GraphChangesRequest = Body(...),
    dataSourceId: str = Query(..., description="Data source whose versioned graph to edit."),
    branchId: str = Query(..., description="Draft branch the changes are committed to."),
    user=Depends(get_optional_user),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Apply a batch of canvas edits to a draft as ONE atomic commit — the unified
    'save' path for draft editing (create/update/delete, nodes and edges, together).

    ``update`` payloads are partial and merged server-side onto the entity's current
    draft state, so the client sends only what changed. Deleting a node cascades to its
    containment subtree + all incident edges (ontology-driven, resolved live). Returns the
    new commit id and a temp-ref→entity-id map for creates so the client can reconcile
    optimistic ids."""
    from backend.app.services.versioning.service import (
        GraphVersioningService, OntologyViolation, MergeConflict, ConcurrencyError)
    from backend.app.services.versioning.ids import prefixed_id
    actor = user.id if user else "system"
    svc = GraphVersioningService()
    g = await svc.get_graph_by_data_source(dataSourceId)
    if g is None or g.get("workspace_id") != ws_id:
        raise HTTPException(status_code=404, detail="no versioned graph for this data source")
    graph_id = g["graph_id"]

    from backend.app.ontology.urn import make_urn
    ops, assigned = _resolve_change_ops(request.ops, prefixed_id, make_urn)

    if not ops:
        return {"commitId": None, "assigned": assigned}

    try:
        commit_id = await svc.apply_ops(
            graph_id=graph_id, branch_id=branchId, ops=ops, actor=actor,
            message=request.message or "Canvas edits",
            containment_edge_types=await _resolve_containment_types(engine),
            ontology_rules=await _resolve_ontology_rules(
                engine, fail_closed=(g.get("kind") == "blank")))
    except OntologyViolation as exc:
        raise HTTPException(status_code=422, detail={"type": "ontology_violation", "violations": exc.violations})
    except MergeConflict as exc:
        raise HTTPException(status_code=409, detail={"type": "merge_conflict", "conflicts": exc.conflicts})
    except ConcurrencyError as exc:
        raise HTTPException(status_code=409, detail={"type": "integrity", "message": str(exc)})

    # Invalidate the draft branch's read cache so the client's NEXT read reflects
    # this commit immediately. Without this, the cached reads for this branch
    # (nodes / children / top-level / layer assignments) keep serving the
    # pre-commit state until their TTL (~30-60s) expires — which is exactly the
    # "my saved change reverts on refresh, then reappears ~20s later" symptom.
    # Draft reads key on CacheScope(ws, ds, branch), so we bump that exact scope.
    # bump_generation swallows Redis errors and never raises, so this can't fail
    # the user's write.
    await get_graph_cache().bump_generation(
        CacheScope(workspace_id=ws_id, data_source_id=dataSourceId, branch_id=branchId)
    )
    return {"commitId": commit_id, "assigned": assigned}


class DeleteImpactResponse(BaseModel):
    """What deleting a node would remove: its containment subtree (nodes) + every incident
    edge (any type). Lists are capped for the UI; ``*Total`` give the true counts. Payloads
    are passed through as-is (camelCase node/edge dicts)."""
    nodes: List[dict]
    edges: List[dict]
    node_total: int = Field(default=0, alias="nodeTotal")
    edge_total: int = Field(default=0, alias="edgeTotal")

    class Config:
        populate_by_name = True


@router.get("/nodes/{urn}/delete-impact", response_model=DeleteImpactResponse)
async def delete_impact(
    urn: str,
    ws_id: str,
    dataSourceId: str = Query(..., description="Data source whose versioned graph to inspect."),
    branchId: str = Query(..., description="Draft branch to compute the impact on."),
    user=Depends(get_optional_user),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Preview the cascade for deleting ``urn`` on a draft: the containment subtree + all
    incident edges that would be removed. Read-only, computed on demand (the lazy-loaded
    canvas needn't hold the subtree) via the SAME helper the commit uses — so the preview
    matches the result. Ontology containment edge types are resolved live."""
    from backend.app.services.versioning.service import GraphVersioningService
    svc = GraphVersioningService()
    g = await svc.get_graph_by_data_source(dataSourceId)
    if g is None or g.get("workspace_id") != ws_id:
        raise HTTPException(status_code=404, detail="no versioned graph for this data source")
    return await svc.delete_impact(
        graph_id=g["graph_id"], branch_id=branchId, root_urn=urn,
        containment_edge_types=await _resolve_containment_types(engine))


# ─── Preflight / guided-create APIs ─────────────────────────────────────────

class AllowedChildOption(BaseModel):
    entity_type: str = Field(alias="entityType")
    label: str
    description: Optional[str] = None
    allowed: bool
    reason: Optional[str] = None     # Non-null when allowed=False (explains why)

    class Config:
        populate_by_name = True


class AllowedEdgeOption(BaseModel):
    edge_type: str = Field(alias="edgeType")
    label: str
    description: Optional[str] = None
    allowed: bool
    reason: Optional[str] = None

    class Config:
        populate_by_name = True


@router.post("/commands/batch", response_model=BatchResponse, response_model_by_alias=True)
async def batch_commands(
    request: BatchCommandRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
    _: object = Depends(require_ws_manage),
):
    """
    Execute a batch of graph mutation commands.

    Each command is one of:
      create_node, update_node, delete_node,
      create_edge, update_edge, delete_edge

    Commands are executed in order. If fail_fast=true (default), execution
    stops on the first failure and returns partial results. If fail_fast=false,
    all commands are attempted and results are collected.

    All node/edge mutations are validated against the active ontology before
    any write is attempted.  Validation failures count as command failures.
    """
    from backend.common.models.graph import CreateNodeRequest as _CNR, CreateEdgeRequest as _CER
    from backend.common.models.graph import UpdateEdgeRequest as _UER

    results: List[BatchCommandResult] = []
    succeeded = 0
    failed = 0

    for cmd in request.commands:
        try:
            if cmd.op == "create_node":
                node_req = _CNR(**cmd.payload)
                res = await engine.create_node(node_req)
                if res.success:
                    succeeded += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=True,
                        createdUrn=res.node.urn if res.node else None,
                    ))
                else:
                    failed += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=False, error=res.error,
                    ))
            elif cmd.op == "create_edge":
                edge_req = _CER(**cmd.payload)
                res = await engine.create_edge(edge_req)
                if res.success:
                    succeeded += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=True,
                        createdEdgeId=res.edge.id if res.edge else None,
                    ))
                else:
                    failed += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=False, error=res.error,
                        warnings=res.warnings,
                    ))
            elif cmd.op == "delete_edge":
                edge_id = cmd.payload.get("edgeId") or cmd.payload.get("edge_id", "")
                ok = await engine.delete_edge(edge_id)
                if ok:
                    succeeded += 1
                    results.append(BatchCommandResult(ref=cmd.ref, op=cmd.op, success=True))
                else:
                    failed += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=False,
                        error=f"Edge '{edge_id}' not found",
                    ))
            else:
                failed += 1
                results.append(BatchCommandResult(
                    ref=cmd.ref, op=cmd.op, success=False,
                    error=f"Unsupported op: {cmd.op}",
                ))
        except Exception as exc:
            failed += 1
            results.append(BatchCommandResult(
                ref=cmd.ref, op=cmd.op, success=False, error=str(exc),
            ))

        if request.fail_fast and failed > 0:
            # Fill remaining commands as skipped
            remaining = request.commands[len(results):]
            for skipped in remaining:
                results.append(BatchCommandResult(
                    ref=skipped.ref, op=skipped.op, success=False,
                    error="Skipped: batch aborted due to earlier failure (fail_fast=true)",
                ))
            break

    # Batch mutations change graph content just like the single-command
    # endpoints — invalidate the response cache + nudge the counts poll.
    # (This call was missing entirely: batch writes previously left the
    # browse caches serving pre-mutation entries until TTL.)
    if succeeded > 0:
        await _invalidate_cache(engine)

    return BatchResponse(
        results=results,
        total=len(request.commands),
        succeeded=succeeded,
        failed=failed,
    )


@router.get("/nodes/{urn}/allowed-children", response_model=List[AllowedChildOption], response_model_by_alias=True)
async def get_allowed_children(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Return all entity types from the active ontology with an indication of
    whether each may be created as a child of this node.

    Used to populate and disable options in the guided create panel.
    """
    return await engine.get_allowed_children(urn)


@router.get("/nodes/{urn}/allowed-edges", response_model=List[AllowedEdgeOption], response_model_by_alias=True)
async def get_allowed_edges(
    urn: str,
    direction: str = Query("outgoing", description="outgoing | incoming | both"),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Return all relationship types from the active ontology with an indication of
    whether each may be created from (or to) this node.

    Used to populate and disable options in the guided edge creator.
    """
    return await engine.get_allowed_edges(urn, direction=direction)
