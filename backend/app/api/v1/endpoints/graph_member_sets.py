"""``/{ws_id}/graph/member-sets`` — everything a scope reaches, resolved in full and downloaded whole.

``POST /graph/members`` answers a scope inside one request, up to 50,000 members: the
Narrow filter's question. A member set answers it COMPLETELY — every source and
consumer up to a million members, a query seed's every match — on versioned and
unversioned graphs alike, so it is kept (``services/member_sets``) and moved on by
whichever request asks next: send the same body with the returned ``setId`` until
``status`` is ``complete``, then list its members page by page or download it.
``common/models/member_set.py`` is the contract.

Mounted under the graph prefix behind the same data-source-or-view gate as
``/graph/members``, and checked the same way BEFORE a set is found or started (a share
link kept inside its view; a query seed's view readable by the caller), because a set
is shared by everyone asking the same question. Under load it rides the same
bulkheads: one fair-share token per request from the trace-closure bucket, and every
graph statement inside it admitted on its own. The export switch gates all three
routes, the Lineage trace switch a set that follows lineage.
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import (
    _admit_graph_request,
    _cache_scope,
    _enforce_fair_share,
    _guard_capability_scope,
    _map_not_implemented,
    _map_validation_error,
    _principal,
    _provider_health_header,
    _search_data_version,
    _statement_admission,
    _view_reader,
    get_context_engine,
    get_engine_session,
)
from backend.app.api.v1.endpoints.graph_export import ExportStreamResponse, take_turn
from backend.app.api.v1.feature_gate import feature_disabled, require_feature
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.auth.dependencies import get_optional_user, get_permission_claims
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db.engine import get_db_session, get_graph_read_db_session, get_readonly_session
from backend.app.db.models import MemberSetORM, MemberSetRowORM
from backend.app.db.repositories.view_membership_repo import now_iso
from backend.app.services.context_engine import ContextEngine
from backend.app.services.feature_flags import feature_flags
from backend.app.services.graph_cache import ENDPOINT_TRACE_CLOSURE
from backend.app.services.member_sets import download, stepper
from backend.app.services.member_sets import store as sets
from backend.app.services.search_downloads import MEMBER_SET, mint_download_token, read_download_token
from backend.app.services.view_membership_search import make_seed_pages, seed_query_for
from backend.common.models.member_set import (
    PAGE_MAX,
    MemberSetMember,
    MemberSetPage,
    MemberSetProgress,
    MemberSetRequest,
    MemberSetStatus,
)
from backend.common.models.view_membership import MembershipCounts, MembershipSpec, Via

router = APIRouter()

require_export = require_feature("graphExportEnabled")

_GONE = "This member set is no longer kept. Ask for it again, without its setId."


def row_sessions():
    """Where a download reads a set's rows from, a session per page: the read-only
    pool, so a long download never holds a connection the web or graph reads need."""
    return get_readonly_session


def _gone() -> HTTPException:
    return refused(404, "set_expired", _GONE)


async def _readable(request: Request, session: AsyncSession, set_id: str, engine) -> MemberSetORM:
    """The set, if it is still kept and was resolved on the graph this request reads
    — and, for a query seed, only for a caller its search's checks would let in."""
    ms = await sets.get(session, set_id)
    scope = (getattr(engine, "_workspace_id", None), getattr(engine, "_data_source_id", None),
             getattr(engine, "_branch_id", None))
    if ms is None or ms.status == "expired" or (ms.workspace_id, ms.data_source_id, ms.branch_id) != scope:
        raise _gone()
    spec = MembershipSpec.model_validate(json.loads(ms.spec))
    if spec.seeds.query is not None:
        _guard_capability_scope(request, seed_query_for(spec, ms.read_in))
    return ms


async def _answer(session: AsyncSession, set_id: str, user) -> MemberSetStatus:
    from backend.auth_service.core import config as auth_config

    ms = await sets.get(session, set_id)
    if ms is None:
        raise _gone()
    queued = 0
    if ms.status == "running" and ms.stage in ("upstream", "downstream"):
        queued = await sets.queued(session, ms.id, ms.stage)
    answer = MemberSetStatus(
        setId=ms.id, specHash=ms.spec_hash, status=ms.status, stage=ms.stage,
        counts=MembershipCounts.model_validate(sets.loads(ms.counts, {})),
        missingSeeds=int(sets.loads(ms.state, {}).get("missing") or 0),
        truncated=sets.loads(ms.truncated, []), dataVersion=ms.data_version,
        progress=MemberSetProgress(steps=ms.step, queued=queued),
        startedAt=ms.created_at, completedAt=ms.completed_at, expiresAt=ms.expires_at,
    )
    if ms.status == "complete":
        answer.download_token = mint_download_token(ms.id, ms.key, _principal(user),
                                                    auth_config.JWT_SECRET_KEY, purpose=MEMBER_SET)
    await session.commit()
    return answer


@router.post(
    "/member-sets",
    response_model=MemberSetStatus,
    response_model_by_alias=True,
    summary="Resolve a scope in full, kept to be listed and downloaded",
    responses=refusal_responses(403, 404, 409, 422, 429, 501, 503),
    dependencies=[Depends(require_export)],
)
async def resolve_member_set(
    request: Request,
    response: Response,
    body: MemberSetRequest = Body(...),
    ws_id: Optional[str] = None,
    viewId: str = Query(..., description="The view the scope is read in."),
    dataSourceId: Optional[str] = Query(None),
    branchId: Optional[str] = Query(None),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
    can_read_view=Depends(_view_reader),
    user=Depends(get_optional_user),
) -> MemberSetStatus:
    """Find or start the set for this scope on the current data, and move it on for
    up to ``waitMs``. The answer says how far it has got (``stage``, ``counts``,
    ``progress``) and every limit it reached (``truncated``); send the same body with
    its ``setId`` to go on, until ``status`` is ``complete`` — that answer carries a
    ``downloadToken``. While another request is moving the same set on, this one
    waits on it and answers with its progress. Lineage follows the trace's rules,
    and needs the Lineage trace switch on.

    404 ``set_expired``: the ``setId`` is no longer kept. 409 ``set_mismatch``: the
    ``setId`` is another question's. 501: this graph cannot walk lineage.
    """
    from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError
    from backend.app.services.deep_search import CompileError

    spec = body.spec.canonical()
    if (spec.expand.upstream or spec.expand.downstream) and not await feature_flags.is_enabled_self_session(
        "traceEnabled", default=fail_safe_default("traceEnabled"),
    ):
        raise feature_disabled("traceEnabled")

    # The checks a search makes on its caller run before a set is found: a set is
    # shared by everyone asking the same question (``graph_members.resolve_members``).
    seed_query, svc, boundary = None, None, ""
    if spec.seeds.query is not None:
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
    scope = _cache_scope(engine)
    if scope is None:
        raise refused(422, "invalid_scope", "A member set is read in a workspace.")

    await _enforce_fair_share(engine, ENDPOINT_TRACE_CLOSURE)
    response.headers["X-Provider-Health"] = _provider_health_header(engine)
    admit = _statement_admission(engine)
    read_in = viewId if seed_query is not None else None

    def key_for(data_version: str) -> str:
        return sets.set_key(scope, spec.spec_hash(), read_in=read_in, boundary=boundary,
                            data_version=data_version, include_edges=body.include_edges)

    if body.set_id:
        ms = await sets.get(session, body.set_id)
        if ms is None or ms.status == "expired" or ms.workspace_id != ws_id:
            raise _gone()
        # Keyed on the data the set was started on: a set the data has moved past
        # finishes for those following it, while a new ask starts a new one.
        if ms.key != key_for(ms.data_version):
            raise refused(409, "set_mismatch", "This setId is another question's. Ask without it.")
    else:
        data_version = await _search_data_version(engine)
        ms = await sets.open_set(
            session, key=key_for(data_version), workspace_id=ws_id,
            data_source_id=getattr(engine, "_data_source_id", None),
            branch_id=getattr(engine, "_branch_id", None), read_in=read_in,
            spec=json.dumps(spec.model_dump(mode="json", by_alias=True, exclude_none=True)),
            spec_hash=spec.spec_hash(), data_version=data_version,
            include_edges=body.include_edges, created_by=_principal(user),
        )
    set_id = ms.id
    await session.commit()

    pages = None
    if seed_query is not None:
        pages = make_seed_pages(svc, seed_query, data_version=ms.data_version, admit=admit)
    try:
        await stepper.drive(session, set_id, engine, owner=uuid.uuid4().hex,
                            wait_s=body.wait_ms / 1000.0, admit=admit, seed_pages=pages)
    except NotImplementedError as exc:
        raise _map_not_implemented(engine, exc) from exc
    except (ValidationError, CompileError) as exc:
        raise _map_validation_error(str(exc)) from exc
    except ValueError as exc:
        raise refused(422, "invalid_scope", str(exc)) from exc
    return await _answer(session, set_id, user)


@router.get(
    "/member-sets/{set_id}/members",
    response_model=MemberSetPage,
    response_model_by_alias=True,
    summary="A page of a member set's members",
    responses=refusal_responses(403, 404),
    dependencies=[Depends(require_export)],
)
async def list_member_set(
    request: Request,
    set_id: str,
    ws_id: Optional[str] = None,
    viewId: Optional[str] = Query(None, description="The view the set was asked for in."),
    after: int = Query(-1, ge=-1, description="The `next` of the page before."),
    limit: int = Query(1000, ge=1, le=PAGE_MAX),
    via: Optional[Via] = Query(None, description="Only the members in for this reason."),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_engine_session),
) -> MemberSetPage:
    """Members in the order they joined, ``limit`` at a time — of a set still
    running too (what it has so far). Read from the set: no graph read."""
    await _readable(request, session, set_id, engine)
    query = select(MemberSetRowORM).where(MemberSetRowORM.set_id == set_id, MemberSetRowORM.seq > after)
    if via is not None:
        query = query.where(MemberSetRowORM.via == via)
    rows = list((await session.execute(query.order_by(MemberSetRowORM.seq).limit(limit + 1))).scalars().all())
    await session.commit()
    page = rows[:limit]
    members = [MemberSetMember(urn=r.urn, via=r.via, hops=download.hops_of(r), hopsUp=r.hops_up,
                               hopsDown=r.hops_down, name=r.name, type=r.type, nearestSeed=r.nearest_seed)
               for r in page]
    return MemberSetPage(members=members, next=page[-1].seq if len(rows) > limit else None)


@router.get(
    "/member-sets/{set_id}/download",
    summary="A complete member set, as a file",
    responses=refusal_responses(400, 403, 404, 422, 429),
    dependencies=[Depends(require_export)],
)
async def download_member_set(
    request: Request,
    set_id: str,
    token: str = Query(..., max_length=2048),
    format: str = Query("csv", description="csv, ndjson or json."),
    part: str = Query("nodes", description="nodes, or edges (csv or ndjson)."),
    columns: Optional[str] = Query(None, description="More columns, comma-separated: a node's fields or "
                                                     "properties."),
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None),
    branchId: Optional[str] = Query(None),
    # Function-scoped: given back before the body streams. The file is read a page at a
    # time in sessions of its own (``row_sessions``), each extra-column lookup admitted
    # on its own.
    _admission: None = Depends(_admit_graph_request, scope="function"),
    session: AsyncSession = Depends(get_graph_read_db_session, scope="function"),
    # The session the route's gate read the data source with (the same one, per request).
    gate: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    claims=Depends(get_permission_claims),
    sessions=Depends(row_sessions),
):
    """A complete set, streamed as it is read — for the person its ``downloadToken``
    was issued to, for an hour after: its members with why each is in, their
    distances and nearest seed (plus any ``columns``), or (``part=edges``) the lineage
    between them when the set was asked for with its edges."""
    from backend.auth_service.core import config as auth_config

    vouched = read_download_token(token, _principal(user),
                                  [key for _kid, key in auth_config.JWT_VERIFICATION_KEYS], purpose=MEMBER_SET)
    if vouched is None or vouched[0] != set_id:
        raise refused(403, "link_expired", "This download link has expired. Ask for the set again.")
    fmt, part = format.lower(), part.lower()
    if fmt not in download.FORMATS or part not in ("nodes", "edges") or (part == "edges" and fmt == "json"):
        raise refused(422, "invalid_format", "Ask for csv, ndjson or json — and for edges, csv or ndjson.")
    if not ws_id:
        raise HTTPException(status_code=400, detail="workspace_id is required (path param ws_id)")
    engine = await get_context_engine(ws_id=ws_id, dataSourceId=dataSourceId, connectionId=None,
                                      branchId=branchId, asOfSeq=None, _admission=None,
                                      session=session, user=user, claims=claims)
    ms = await _readable(request, session, set_id, engine)
    if ms.status != "complete" or ms.key != vouched[1]:
        raise _gone()
    await session.execute(update(MemberSetORM).where(MemberSetORM.id == set_id).values(last_read_at=now_iso()))
    await session.commit()
    meta = {"setId": ms.id, "specHash": ms.spec_hash, "spec": json.loads(ms.spec),
            "dataVersion": ms.data_version, "counts": sets.loads(ms.counts, {}),
            "truncated": sets.loads(ms.truncated, []), "completedAt": ms.completed_at,
            "includeEdges": bool(ms.include_edges)}
    extra = [c.strip() for c in (columns or "").split(",") if c.strip()]
    # The gate's read is done: give its connection back now, not when the download ends.
    await gate.commit()
    turn = await take_turn()
    return ExportStreamResponse(
        download.stream(sessions, ms.id, fmt=fmt, part=part, columns=extra, engine=engine,
                        admit=_statement_admission(engine), meta=meta),
        turn=turn, fmt=fmt, filename=f"member-set-{ms.spec_hash[:12]}" + ("-edges" if part == "edges" else ""))
