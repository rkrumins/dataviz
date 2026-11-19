"""Views made from a query: ``POST /views/from-members`` and ``/views/{id}/membership``.

A view made from a query is a whole view — its own layers, sharing and versions —
whose members come from one or more queries (``config.membership``, the contract in
``backend/common/models/view_membership.py``). An auto-updating one keeps them in
step with the data; a snapshot keeps them as they were.

* ``POST /views/from-members`` — make one. What its sources reach is worked out before
  it is saved (202 while it is: ask again): over the limit, nothing is made and the
  answer says by how much. Its members are then placed, a page at a time.
* ``GET /views/{id}/membership`` — the definition and how keeping it is going
  (an ETag, so a poll costs a 304).
* ``PUT /views/{id}/membership`` — change the queries, freeze or resume, against the
  definition hash it was read at (a stale one is a 409 with the current definition).
* ``POST /views/{id}/membership/members`` — keep entities out, bring them back,
  always include them, or stop.
* ``POST /views/{id}/membership/refresh`` — *Refresh now*.

Mounted at ``/views`` before ``views.router``, so no ``/{view_id}`` route there
can capture these. Graph work goes through the same doors as a graph read: request
admission per data source, the GRAPH_READ bulkhead, one fair-share token from the
trace-closure bucket, and a slot per statement; the WEB session is committed
before it, so no connection is held while the graph answers.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional, Set

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.graph import _enforce_fair_share
from backend.app.api.v1.endpoints.views import (
    _compute_ontology_digest,
    _template_version,
    _user_id,
    authorize_view_create,
)
from backend.app.api.v1.feature_gate import ensure_view_mode_allowed, feature_disabled, require_feature
from backend.app.api.v1.refusal import refusal_responses, refused
from backend.app.api.v1.view_read_scope import viewer_context
from backend.app.auth.dependencies import get_optional_user, get_permission_claims, rbac_flag
from backend.app.config import resilience
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db.engine import get_db_session, get_graph_read_session
from backend.app.db.models import ViewORM, view_is_live
from backend.app.db.repositories import (
    view_activity_repo, view_members_repo, view_membership_repo, view_repo, view_version_repo,
)
from backend.app.db.repositories.view_membership_repo import dumps, loads, now_iso
from backend.app.jobs.metrics import increment
from backend.app.providers.manager import provider_manager
from backend.app.services import template_access, view_access
from backend.app.services.feature_flags import feature_flags
from backend.app.services.graph_cache import ENDPOINT_TRACE_CLOSURE
from backend.app.services.live_views import layouts, pipeline
from backend.app.services.live_views.ownership import MemberOpError, apply_member_ops, layer_ids_of
from backend.app.services.live_views.pipeline import EngineScope, PipelineError
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.view_transfer.sources import engine_for
from backend.common.adapters import ProviderUnavailable
from backend.common.models.management import ViewCreateRequest, ViewResponse
from backend.common.models.member_set import MemberSetStatus
from backend.common.models.view_membership import (
    MACHINE,
    FromMembersRequest,
    MemberOps,
    MembershipDefinition,
    MembershipResolving,
    MembershipSource,
    MembershipStatus,
    MembershipUpdate,
    ReadInView,
    RefreshResult,
    read_definition,
)

router = APIRouter()

#: A preview: it ships off, and a flag that cannot be read means off — never the preview.
require_membership = require_feature("viewMembershipEnabled", default=False)

#: *Refresh now* at most this often per view (a definition change, or a held update
#: being confirmed, may refresh straight away).
REFRESH_MIN_INTERVAL_SECS = 30
#: ``last_read_at`` is written at most this often: it says a view is still looked at.
READ_STAMP_SECS = 3600


class ViewWithMembership(BaseModel):
    """A view made from a query, and how keeping it is going."""
    model_config = ConfigDict(populate_by_name=True)
    view: ViewResponse
    membership: MembershipStatus


def _budget_s() -> float:
    """One request's turn on the web tier: ``LIVE_VIEW_TURN_SECS``, and always 8 s inside
    the tier every ``/views`` request is cut off at (``HTTP_TIMEOUT_DEFAULT_SECS``), so a
    turn answers — saying how far it got — before it is cut off."""
    return max(5.0, min(pipeline.TURN_SECS, resilience.HTTP_TIMEOUT_DEFAULT_SECS - 8))


def get_engine_scope() -> EngineScope:
    """An engine for one data source, opened around a graph phase and closed after
    it: admitted like a graph request to that source, on the GRAPH_READ bulkhead,
    and charged one fair-share token (a resolution is a burst of closure steps)."""

    @asynccontextmanager
    async def scope(workspace_id: str, data_source_id: Optional[str], actor: Optional[str]):
        key = f"{workspace_id}/{data_source_id or ''}"
        provider_manager.admit_graph_request(key)
        try:
            async with get_graph_read_session() as session:
                try:
                    engine = await engine_for(session, workspace_id, data_source_id, actor=actor)
                except KeyError as exc:
                    raise PipelineError("source_missing", "This view's data source can't be found.") from exc
                await _enforce_fair_share(engine, ENDPOINT_TRACE_CLOSURE)
                yield engine
        finally:
            provider_manager.release_graph_request(key)

    return scope


def _refused(exc: PipelineError) -> HTTPException:
    code = {"not_found": 404, "frozen": 409}.get(exc.kind, 422)
    return HTTPException(status_code=code, detail={"reason": exc.kind, "message": str(exc)})


async def _require_trace_for(sources: List[MembershipSource]) -> None:
    """Lineage is the trace's, and needs the Lineage trace switch on."""
    if any(s.spec.expand.upstream or s.spec.expand.downstream for s in sources) and not (
        await feature_flags.is_enabled_self_session("traceEnabled", default=fail_safe_default("traceEnabled"))
    ):
        raise feature_disabled("traceEnabled")


async def _check_views(
    session: AsyncSession,
    ctx: view_access.ViewerContext,
    definition: MembershipDefinition,
    *,
    workspace_id: str,
    data_source_id: Optional[str],
    self_id: Optional[str] = None,
) -> Optional[dict]:
    """Every view the definition names — the ones its queries are searched in, and
    the one whose layers it copies or follows — readable by the caller, in the same
    workspace and data source, none of them the view itself, and a followed one a view
    that can be followed (``pipeline.follow_refusal``). Returns the config of the view
    whose layers are copied or followed."""
    names: Set[str] = {s.read_in for s in definition.sources if s.read_in}
    layout = definition.layout
    if layout.kind in ("source", "follow"):
        if not layout.source_view_id:
            raise refused(422, "source_view_required", "Name the view whose layers to copy (sourceViewId).")
        names.add(layout.source_view_id)
    copied: Optional[dict] = None
    for view_id in sorted(names):
        if view_id == self_id:
            raise refused(422, "read_in_self",
                          "A view's query is searched in another view, not in itself.")
        other = (await session.execute(
            select(ViewORM).where(ViewORM.id == view_id, view_is_live()))).scalar_one_or_none()
        if other is None or (rbac_flag("RBAC_ENFORCE_VIEWS") and not await view_access.can_read_view(
                session, ctx, other)):
            raise refused(404, "view_not_found", f"View '{view_id}' not found")
        if other.workspace_id != workspace_id:
            raise refused(422, "view_other_workspace", "That view is in another workspace.")
        theirs = await pipeline.effective_data_source(session, other.workspace_id, other.data_source_id)
        if theirs != data_source_id:
            raise refused(422, "view_other_data_source", "That view shows a different data source.")
        if view_id == layout.source_view_id:
            copied = pipeline.config_of(other)
            refusal = pipeline.follow_refusal(copied) if layout.kind == "follow" else None
            if refusal:
                raise refused(422, *refusal)
    return copied


async def membership_status(
    session: AsyncSession, row: ViewORM, definition: MembershipDefinition,
    ctx: Optional[view_access.ViewerContext] = None,
) -> MembershipStatus:
    """How keeping ``row`` up to date stands. The name of a view searched in, or
    followed, is shown only to someone who can open it."""
    state = await view_membership_repo.get(session, row.id)
    _, assignments = pipeline.layout_of(pipeline.config_of(row))
    people = sorted(u for u, e in assignments.items() if e.get("assignedBy") != MACHINE)
    read_in: List[ReadInView] = []
    for view_id, other in (await pipeline.read_in_views(session, definition)).items():
        visible = other is not None and (ctx is None or not rbac_flag("RBAC_ENFORCE_VIEWS")
                                         or await view_access.can_read_view(session, ctx, other))
        read_in.append(ReadInView(view_id=view_id, name=other.name if visible else None,
                                  available=other is not None))
    follows: Optional[ReadInView] = None
    if definition.layout.kind == "follow":
        base = (await session.execute(select(ViewORM).where(
            ViewORM.id == definition.layout.source_view_id, view_is_live()))).scalar_one_or_none()
        if base is not None and base.workspace_id != row.workspace_id:
            base = None
        visible = base is not None and (ctx is None or not rbac_flag("RBAC_ENFORCE_VIEWS")
                                        or await view_access.can_read_view(session, ctx, base))
        follows = ReadInView(view_id=definition.layout.source_view_id, name=base.name if visible else None,
                             available=base is not None)
    if definition.mode != "live" and _running(state, definition) is None:
        status = "frozen"
    else:
        status = state.status if state is not None and state.status != "frozen" else "pending"
    members = state.member_count if state is not None and state.members_epoch is not None else 0
    return MembershipStatus(
        mode=definition.mode,
        status=status,
        detail=loads(state.status_detail) if state is not None else None,
        revision=state.revision if state is not None else 0,
        definition=definition,
        definition_hash=definition.definition_hash(),
        counts=loads(state.counts) if state is not None else None,
        keys=members + len(people),
        limit=pipeline.entry_limit(),
        last_applied_at=state.last_applied_at if state is not None else None,
        last_diff=loads(state.last_diff) if state is not None else None,
        truncated=(loads(state.truncated) or []) if state is not None else [],
        read_in=read_in,
        follows=follows,
        always_included=people,
        excluded=list(definition.exclude),
    )


def _running(state, definition: MembershipDefinition) -> Optional[dict]:
    """The run working the view out now, if any: one a request before left ``running``
    (or a new view's first answer), which the next request carries on."""
    return view_membership_repo.in_progress(state, definition.resolution_hash())


async def _view(
    session: AsyncSession, view_id: str, user, claims: PermissionClaims, *, edit: bool, lock: bool = False,
) -> tuple:
    """``(row, viewer)`` for a live view the caller can read (404 otherwise, so a
    view's existence stays private), and edit when ``edit`` (403)."""
    query = select(ViewORM).where(ViewORM.id == view_id, view_is_live())
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(query)).scalar_one_or_none()
    ctx = await viewer_context(session, user, claims)
    if row is None or (rbac_flag("RBAC_ENFORCE_VIEWS") and not await view_access.can_read_view(session, ctx, row)):
        raise refused(404, "view_not_found", f"View '{view_id}' not found")
    if edit and rbac_flag("RBAC_ENFORCE_VIEWS") and not await view_access.can_edit_view(session, ctx, row):
        raise refused(403, "missing_permission", "Missing permission: workspace:view:edit",
                      error="missing_permission", permission="workspace:view:edit")
    return row, ctx


def _definition_of(row: ViewORM) -> MembershipDefinition:
    definition = read_definition(pipeline.config_of(row))
    if definition is None:
        raise HTTPException(status_code=404, detail={"reason": "not_made_from_a_query",
                                                     "message": "This view isn't made from a query."})
    return definition


async def _replayed(session: AsyncSession, request_id: str, actor: str) -> Optional[ViewWithMembership]:
    """What a previous attempt of this request made, if it made anything. A request id
    is the client's: someone else's — or one used for something else — is a 409."""
    version = await view_version_repo.find_by_request_id(session, request_id)
    if version is None:
        return None
    row = (await session.execute(select(ViewORM).where(ViewORM.id == version.view_id, view_is_live()))
           ).scalar_one_or_none()
    if version.source != "create" or version.created_by != actor or row is None:
        raise refused(409, "request_id_taken", (
            "This Idempotency-Key was already used for another request. Send a new key for a new "
            "request."), type="request_id_taken")
    definition = _definition_of(row)
    view = await view_repo.get_view_enriched(session, row.id, user_id=actor)
    return ViewWithMembership(view=view, membership=await membership_status(session, row, definition))


async def _refresh_quietly(view_id: str, *, session: AsyncSession, engine_scope: EngineScope,
                           actor: str) -> Optional[pipeline.Outcome]:
    """Work a changed definition out straight away when the graph can answer; when it
    can't, the view stays pending and says so — the change itself is saved."""
    try:
        return await pipeline.refresh(view_id, session=session, engine_scope=engine_scope,
                                      owner=f"web:{uuid.uuid4().hex[:12]}", budget_s=_budget_s(), actor=actor)
    except (PipelineError, ProviderUnavailable):
        await session.rollback()
        return None


async def _record_update(session: AsyncSession, row: ViewORM, outcome: Optional[pipeline.Outcome],
                         actor: str) -> None:
    if outcome is None or outcome.outcome != "applied" or not outcome.diff:
        return
    diff = outcome.diff
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="data_changed", actor=actor,
        summary=f"Updated from its query: +{diff.get('added', 0)} −{diff.get('removed', 0)}",
        changes={"membership": {k: diff.get(k, 0) for k in ("added", "removed", "moved")}},
    )


# ── Make a view from a query ─────────────────────────────────────────────────

@router.post(
    "/from-members", response_model=ViewWithMembership, response_model_by_alias=True, status_code=201,
    summary="Make a list view of a narrowing's members",
    responses={202: {"description": "What the sources reach is still being worked out: nothing was made. "
                                    "Send the same request again (the same Idempotency-Key too) to carry on.",
                     "model": MembershipResolving},
               **refusal_responses(403, 404, 409, 422, 429, 501, 503)},
    dependencies=[Depends(require_membership)],
)
async def create_view_from_members(
    response: Response,
    body: FromMembersRequest = Body(...),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key", max_length=128),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    engine_scope: EngineScope = Depends(get_engine_scope),
) -> ViewWithMembership:
    """Make a view whose members come from one or more queries.

    Each source is a membership spec (``POST /{ws}/graph/members``) — a query is
    searched in the view named by ``readIn`` — and the layout says how the members
    are arranged: like the view they came from (``source``: its layers, kept only
    where they hold something unless ``keep`` is ``all``), by a template's rules or
    the client's own layers (``template``, ``custom``: send ``layers``), by
    top-level type (``auto``), by lineage distance (``stages``), or in the layers of
    a view it follows (``follow``: that view's as it has them now, each member where
    it places it — a subset of that view, listed among its subsets; a view that is a
    subset itself, or made from a query, can't be followed: 422 ``base_is_subset``,
    ``base_is_list``).

    ``mode`` ``live`` (the default) keeps the members in step with the data;
    ``snapshot`` keeps them as they are now. What the sources reach is worked out in
    full before anything is saved, a step at a time: while it is, the answer is 202
    ``{"status": "resolving", "sets": [...]}`` (each source's member set, as
    ``POST /graph/member-sets`` answers it) after ``waitMs`` (at most one turn), and
    nothing is made — send the same request again to carry on. Past the limit
    (``limit``: members; the containers around them are drawn from their paths) nothing
    is made and the 422 says by how much; when the graph cannot answer in full, nothing
    is made and the 503 says when to retry. The view is made (201) once that is known,
    and a first short turn (``LIVE_VIEW_CREATE_TURN_SECS``) places what it can: a small
    view is ``ok``; a larger one says ``updating``, with how far it got (``detail``:
    ``reason`` ``placing``, ``placed`` of ``members``) — opening it, or *Refresh now*,
    carries it on. Its layers are the preview's (``POST /graph/members/plan``) when one
    was asked for the same sources and layout.

    ``Idempotency-Key`` makes a retry safe: the same caller sending the same key
    gets the view the first attempt made (200, its status as it is now — maybe still
    ``updating``), never a second one. A 202 records nothing against it.
    """
    started = time.monotonic()
    budget = _budget_s()
    actor = _user_id(user)
    request_id = f"fm:{actor}:{idempotency_key}" if idempotency_key else None
    if request_id:
        replayed = await _replayed(session, request_id, actor)
        if replayed is not None:
            response.status_code = 200
            return replayed
    await _require_trace_for(body.sources)

    async def authorize() -> tuple:
        await authorize_view_create(claims, session, workspace_id=body.workspace_id,
                                    data_source_id=body.data_source_id, visibility=body.visibility)
        await ensure_view_mode_allowed("reference", session)
        ctx = await viewer_context(session, user, claims)
        ds = await pipeline.effective_data_source(session, body.workspace_id, body.data_source_id)
        return ctx, ds, await _check_views(session, ctx, definition, workspace_id=body.workspace_id,
                                           data_source_id=ds)

    definition = MembershipDefinition(
        mode=body.mode, sources=body.sources, layout=body.layout, exclude=body.exclude,
        provenance=body.provenance.model_copy(update={"created_at": now_iso(), "created_by": actor}),
    )
    if body.layout.kind in ("template", "custom") and not body.layers:
        raise refused(422, "layers_required", "Send the layers the view starts with.")
    _, _, copied_from = await authorize()
    await session.commit()                 # nothing held while the graph answers

    limit = pipeline.entry_limit()
    try:
        async with engine_scope(body.workspace_id, body.data_source_id, actor) as engine:
            found = await pipeline.resolve_sets(
                session, engine, definition.sources, workspace_id=body.workspace_id,
                data_source_id=body.data_source_id,
                wait_s=min(body.wait_ms / 1000.0, max(0.0, budget - (time.monotonic() - started))),
            )
            if not found.complete:
                return _resolving(await pipeline.statuses(session, found))
            if found.retryable:
                await pipeline.retire_short(session, found)
                raise HTTPException(status_code=503, headers={"Retry-After": str(int(pipeline.RETRY_SECS))}, detail={
                    "reason": "short_answer", "truncated": found.retryable,
                    "message": "The graph couldn't answer in full, so nothing was saved. Try again in a moment.",
                })
            draft = await pipeline.draft_cached(
                session, engine, found, definition, source_config=copied_from, client_layers=body.layers,
                keep=body.keep, limit=limit, place_sample=body.layout.kind not in ("template", "custom", "follow"),
                bounded=True)
    except PipelineError as exc:
        raise _refused(exc) from exc
    except NotImplementedError as exc:
        raise refused(501, "unsupported", str(exc) or "This graph can't work out what the query reaches.") from exc
    if draft.over_cap:
        raise HTTPException(status_code=422, detail={
            "reason": "over_cap", "keys": draft.members, "members": draft.members, "containers": 0,
            "limit": limit,
            "message": f"This would hold {draft.members:,} members, and a view holds at most {limit:,}.",
        })

    # Saved in one transaction, everything checked again: the data source is held in its
    # workspace until it commits, and the views it names are still there to read.
    await authorize()
    config = pipeline.view_config(draft, icon=body.icon)
    try:
        await view_repo.check_layer_rules(session, view_repo._base_reference_layout(config), {})
    except ValueError as exc:
        raise refused(422, "invalid_layers", str(exc)) from exc
    template_id = body.context_model_id or body.layout.template_id
    if template_id:
        template_id = await template_access.usable_template_id(
            session, user=user, claims=claims, template_id=template_id)
    view = await view_repo.create_view(session, ViewCreateRequest(
        name=body.name, description=body.description, workspace_id=body.workspace_id,
        data_source_id=body.data_source_id, view_type="reference", config=config,
        visibility=body.visibility, tags=body.tags, context_model_id=template_id,
        context_model_version=await _template_version(session, template_id, body.context_model_version),
    ), ontology_digest=await _compute_ontology_digest(session, body.workspace_id, body.data_source_id),
        user_id=actor)
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view.id))).scalar_one()
    if body.layout.kind == "follow":
        row.subset_of = body.layout.source_view_id      # among that view's subsets, served its layers
    version, created = await view_version_repo.checkpoint(
        session, row, source="create", actor=actor, request_id=request_id,
        provenance={"madeFrom": draft.definition.provenance.model_dump(by_alias=True, exclude_none=True)},
    )
    if not created and version.view_id != row.id:
        # The same request, sent twice at once: the other copy made the view.
        await session.rollback()
        response.status_code = 200
        replayed = await _replayed(session, request_id, actor) if request_id else None
        if replayed is None:
            raise refused(409, "made_by_another_request", "This view was just made by another request.")
        return replayed
    owner = f"web:{uuid.uuid4().hex[:12]}"
    await pipeline.start(session, row, draft.definition, found, owner=owner, members=draft.members)
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="created", actor=actor,
        summary=f'Created "{row.name}" from a query',
    )
    await session.commit()                 # made: its members are placed after, a page at a time

    left = max(0.0, budget - (time.monotonic() - started))
    try:
        await pipeline.carry_on(row.id, session=session, engine_scope=engine_scope, owner=owner,
                                budget_s=min(pipeline.CREATE_TURN_SECS, left), apply_budget_s=left, actor=actor)
    except (PipelineError, ProviderUnavailable):
        # Made all the same: its members are worked out when it is next opened.
        await session.rollback()
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view.id)
                                 .execution_options(populate_existing=True))).scalar_one()
    view = await view_repo.get_view_enriched(session, row.id, user_id=actor)
    return ViewWithMembership(view=view, membership=await membership_status(session, row, draft.definition))


def _resolving(found: List[MemberSetStatus]) -> JSONResponse:
    """202: what the sources reach is still being worked out, and nothing was made."""
    body = MembershipResolving(sets=[s.model_dump(mode="json", by_alias=True, exclude_none=True) for s in found])
    return JSONResponse(status_code=202, content=body.model_dump(mode="json", by_alias=True))


# ── How keeping it is going ──────────────────────────────────────────────────

@router.get(
    "/{view_id}/membership", response_model=MembershipStatus, response_model_by_alias=True,
    summary="Read a list view's members, and how its updates stand",
    responses=refusal_responses(304, 403, 404),
    dependencies=[Depends(require_membership)],
)
async def get_view_membership(
    request: Request,
    response: Response,
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """What the view is made of, and how keeping it up to date is going: its status
    (with what to do about it in ``detail``), counts against the limit, the last
    update's changes, the entities always included and kept out. Answers 304 to an
    ``If-None-Match`` that still holds."""
    row, ctx = await _view(session, view_id, user, claims, edit=False)
    status = await membership_status(session, row, _definition_of(row), ctx)
    body = status.model_dump(mode="json", by_alias=True)
    etag = 'W/"' + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:32] + '"'
    state = await view_membership_repo.get(session, view_id)
    if state is not None and _older_than(state.last_read_at, READ_STAMP_SECS):
        state.last_read_at = now_iso()
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return status


def _older_than(stamp: Optional[str], seconds: float) -> bool:
    if not stamp:
        return True
    try:
        then = datetime.fromisoformat(stamp)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - then > timedelta(seconds=seconds)


# ── Change what it is made of ────────────────────────────────────────────────

@router.put(
    "/{view_id}/membership", response_model=MembershipStatus, response_model_by_alias=True,
    summary='Change what a list view is made of, or freeze or resume it',
    responses=refusal_responses(403, 404, 409, 422),
    dependencies=[Depends(require_membership)],
)
async def update_view_membership(
    view_id: str = Path(...),
    body: MembershipUpdate = Body(...),
    branch_id: Optional[str] = Query(None, alias="branchId"),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    engine_scope: EngineScope = Depends(get_engine_scope),
):
    """Change the queries a view's members come from, which entities it keeps out,
    or whether it keeps itself up to date (``mode``: ``snapshot`` freezes it as it
    is, ``live`` resumes). Sent with the ``definitionHash`` it was read at: a 409
    answers a stale one with the current definition.

    Changes to the queries, or resuming, work the members out again straight away
    when the graph can answer; otherwise the view stays ``pending`` and says so.
    Made on the published view only — a draft changes its layout, not this."""
    if branch_id:
        raise refused(409, "draft_refused",
                      "What a view is made of is changed on the published view, not in a draft.")
    actor = _user_id(user)
    row, ctx = await _view(session, view_id, user, claims, edit=True, lock=True)
    definition = _definition_of(row)
    if body.if_definition_hash != definition.definition_hash():
        raise HTTPException(status_code=409, detail={
            "reason": "changed", "message": "Someone changed what this view is made of. Review it and try again.",
            "definition": definition.model_dump(mode="json", by_alias=True, exclude_none=True),
            "definitionHash": definition.definition_hash(),
        })
    changes = body.model_dump(by_alias=False, exclude_none=True, exclude={"if_definition_hash"})
    if body.layout is not None and (body.layout.kind, body.layout.source_view_id, body.layout.template_id) != (
            definition.layout.kind, definition.layout.source_view_id, definition.layout.template_id):
        raise refused(422, "layout_fixed", (
            "A view keeps the layout it was made with. To arrange the same query another way, make a new view."))
    updated = MembershipDefinition.model_validate({
        **definition.model_dump(by_alias=False), **changes,
    })
    if body.sources is not None:
        await _require_trace_for(updated.sources)
        ds = await pipeline.effective_data_source(session, row.workspace_id, row.data_source_id)
        await _check_views(session, ctx, updated, workspace_id=row.workspace_id, data_source_id=ds,
                           self_id=row.id)

    config = pipeline.config_of(row)
    state = await view_membership_repo.ensure(session, row)
    if body.exclude is not None:
        ref = config.setdefault("layout", {}).setdefault("referenceLayout", {})
        _, assignments = pipeline.layout_of(config)
        gone = sorted(set(body.exclude) - set(definition.exclude))
        back = sorted(set(definition.exclude) - set(body.exclude))
        try:
            ref["assignments"], _, out = apply_member_ops(
                assignments, definition.exclude, MemberOps(exclude=gone, unexclude=back), members={},
                layer_ids=layer_ids_of(ref), now=now_iso())
        except MemberOpError as exc:
            raise refused(422, "invalid_member_ops", str(exc)) from exc
        state.member_count -= await view_members_repo.drop(session, row.id, state.members_epoch, out)
    config["membership"] = updated.model_dump(mode="json", by_alias=True, exclude_none=True)
    row.config = json.dumps(config)
    row.updated_by = actor

    work_out = updated.mode == "live" and (
        updated.resolution_hash() != definition.resolution_hash() or definition.mode != "live"
        or updated.layout != definition.layout or bool(set(definition.exclude) - set(updated.exclude)))
    if updated.mode != "live":
        state.status, state.status_detail, state.held = "frozen", None, None
        if definition.mode == "live":
            # A run working it out now is overtaken: its members stay as they are.
            state.epoch, state.materialize, state.lease_owner, state.lease_until = state.epoch + 1, None, None, None
    elif work_out:
        state.status = "pending"
        state.status_detail = dumps({"reason": "definition_changed"})
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="updated", actor=actor,
        summary=_definition_summary(definition, updated), changes={"membership": sorted(changes)},
    )
    await session.commit()

    if work_out:
        outcome = await _refresh_quietly(view_id, session=session, engine_scope=engine_scope, actor=actor)
        await _record_update(session, row, outcome, actor)
    row, ctx = await _view(session, view_id, user, claims, edit=False)
    return await membership_status(session, row, _definition_of(row), ctx)


def _definition_summary(before: MembershipDefinition, after: MembershipDefinition) -> str:
    if before.mode != after.mode:
        return ("Stopped updating its members: a snapshot now" if after.mode != "live"
                else "Resumed updating its members from its query")
    if before.resolution_hash() != after.resolution_hash():
        return "Changed the query its members come from"
    if before.exclude != after.exclude:
        return "Changed which entities it keeps out"
    return "Changed how its members are kept"


# ── Keep out, bring back, always include ─────────────────────────────────────

@router.post(
    "/{view_id}/membership/members", response_model=ViewWithMembership, response_model_by_alias=True,
    summary='Keep entities out of a list view, bring them back, or always include them',
    responses=refusal_responses(403, 404, 409, 422),
    dependencies=[Depends(require_membership)],
)
async def change_view_members(
    view_id: str = Path(...),
    body: MemberOps = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    engine_scope: EngineScope = Depends(get_engine_scope),
):
    """Keep entities out of the view whatever its query finds (``exclude``), let the
    query decide again (``unexclude``), always include an entity in a layer
    (``include``: one the query found becomes yours, where it sits), or stop
    (``uninclude``). Kept out takes effect at once; an entity brought back returns
    with the update this starts (when the graph can answer; else the next one)."""
    actor = _user_id(user)
    row, ctx = await _view(session, view_id, user, claims, edit=True, lock=True)
    definition = _definition_of(row)
    config = pipeline.config_of(row)
    ref = config.setdefault("layout", {}).setdefault("referenceLayout", {})
    _, assignments = pipeline.layout_of(config)
    state = await view_membership_repo.ensure(session, row)
    members = await view_members_repo.placements(session, view_id, state.members_epoch,
                                                 [item.urn for item in body.include])
    layer_ids = layer_ids_of(ref)
    if definition.layout.kind == "follow":
        # It stores no layers: its own are the ones it is served (none, the view it follows gone).
        base = await pipeline.source_config(session, definition, row.workspace_id)
        layer_ids = layouts.layer_ids(layouts.followed(base)) if base is not None else []
    try:
        ref["assignments"], exclude, gone = apply_member_ops(
            assignments, definition.exclude, body, members=members, layer_ids=layer_ids, now=now_iso())
    except MemberOpError as exc:
        raise refused(422, "invalid_member_ops", str(exc)) from exc
    # Kept out, or a person's own entry now: out of the members at once.
    state.member_count -= await view_members_repo.drop(session, view_id, state.members_epoch, gone)
    config.setdefault("content", {})["entityScope"] = "curated"
    updated = definition.model_copy(update={"exclude": exclude})
    config["membership"] = updated.model_dump(mode="json", by_alias=True, exclude_none=True)
    row.config = json.dumps(config)
    row.updated_by = actor
    work_out = definition.mode == "live" and bool(body.unexclude or body.uninclude)
    if work_out:
        await view_membership_repo.mark_pending(session, row, reason="members_changed")
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="updated", actor=actor,
        summary=_ops_summary(body), changes={"membership": {
            k: len(getattr(body, k)) for k in ("exclude", "unexclude", "include", "uninclude") if getattr(body, k)}},
    )
    await session.commit()

    if work_out:
        outcome = await _refresh_quietly(view_id, session=session, engine_scope=engine_scope, actor=actor)
        await _record_update(session, row, outcome, actor)
    row, ctx = await _view(session, view_id, user, claims, edit=False)
    view = await view_repo.get_view_enriched(session, view_id, user_id=actor)
    return ViewWithMembership(view=view, membership=await membership_status(session, row, _definition_of(row), ctx))


def _ops_summary(ops: MemberOps) -> str:
    parts = []
    for items, words in ((ops.exclude, "Kept {} out"), (ops.unexclude, "Let its query decide on {} again"),
                         (ops.include, "Always includes {}"), (ops.uninclude, "Stopped always including {}")):
        if items:
            parts.append(words.format(f"{len(items):,} {'entity' if len(items) == 1 else 'entities'}"))
    return "; ".join(parts) or "Changed its members"


# ── Refresh now ──────────────────────────────────────────────────────────────

@router.post(
    "/{view_id}/membership/refresh", response_model=RefreshResult, response_model_by_alias=True,
    summary="Work a list view's members out again",
    responses={202: {"description": "Still being worked out (`outcome`: `running` — ask again to carry it on) "
                                    "or another request is updating it now (`busy`); the status answers as it "
                                    "stands.", "model": RefreshResult},
               **refusal_responses(403, 404, 409, 429, 503)},
    dependencies=[Depends(require_membership)],
)
async def refresh_view_membership(
    response: Response,
    view_id: str = Path(...),
    confirm_removals: bool = Query(False, alias="confirmRemovals"),
    trigger: Literal["manual", "open"] = Query(
        "manual", description="``open``: the view was opened. Brings it up to date if its data "
                              "changed since it last was; anyone who can read the view may."),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    engine_scope: EngineScope = Depends(get_engine_scope),
):
    """Work the view's members out again now and apply them.

    ``outcome`` says what happened: ``applied`` (with ``diff``), ``unchanged``,
    ``running`` — a large view is worked out a step at a time, and this request's turn
    is spent: ask again (202) to carry it on — ``held`` — an update would remove at
    least half the view's members (and at least 50), so it waits; send
    ``confirmRemovals=true`` to apply it — ``over_cap``, ``deferred`` (the graph
    answered short; the view kept its members), or ``busy`` (another request is working
    on it: 202). At most once every 30 seconds per view, except to carry a run on or
    confirm a held one; a 429 says when.

    ``trigger=open`` — the view was opened. It applies the view's own query and
    changes nothing about the view, so anyone who can read it may ask: nothing is
    read from the graph unless the data or the query changed since it was last
    worked out (or a run is still working it out, which this carries on), a held
    removal stays held, and within 30 seconds of the last update it answers
    ``current`` rather than a 429."""
    actor = _user_id(user)
    opened = trigger == "open"
    row, ctx = await _view(session, view_id, user, claims, edit=not opened)
    definition = _definition_of(row)
    state = await view_membership_repo.get(session, view_id)
    running = _running(state, definition) is not None
    if opened:
        confirm_removals = False
        reason = ("snapshot" if definition.mode != "live" and not running
                  else "recent" if state is not None and not running and not _older_than(
                      state.last_started_at, REFRESH_MIN_INTERVAL_SECS)
                  else None)
        if reason:
            increment("live_view_refresh_total", outcome="current", trigger="open")
            return RefreshResult(outcome="current", detail={"reason": reason},
                                 membership=await membership_status(session, row, definition, ctx))
    elif definition.mode != "live" and not running:
        raise HTTPException(status_code=409, detail={"reason": "frozen", "message": (
            "This view is a snapshot: its members stay as they are. Resume updates to refresh it.")})
    # A change waiting to be worked out, a run to carry on, or a held update being
    # confirmed goes straight ahead; one another request is running answers busy below.
    elif state is not None and not running and not _older_than(state.last_started_at, REFRESH_MIN_INTERVAL_SECS) \
            and not (state.status in ("pending", "updating") or (state.status == "held" and confirm_removals)):
        wait = REFRESH_MIN_INTERVAL_SECS
        try:
            started = datetime.fromisoformat(state.last_started_at)
            wait = max(1, int(REFRESH_MIN_INTERVAL_SECS - (datetime.now(timezone.utc) - started).total_seconds()))
        except (TypeError, ValueError):
            pass
        increment("live_view_refresh_total", outcome="too_soon", trigger="manual")
        raise HTTPException(status_code=429, headers={"Retry-After": str(wait)}, detail={
            "reason": "too_soon", "message": f"This view was just updated. Try again in {wait} seconds."})
    await session.commit()
    try:
        outcome = await pipeline.refresh(
            view_id, session=session, engine_scope=engine_scope, owner=f"web:{uuid.uuid4().hex[:12]}",
            budget_s=_budget_s(), confirm_removals=confirm_removals, actor=actor,
            only_if_changed=opened,
        )
    except PipelineError as exc:
        raise _refused(exc) from exc
    await _record_update(session, row, outcome, actor)
    increment("live_view_refresh_total", outcome=outcome.outcome, trigger="open" if opened else "manual")
    if outcome.outcome in ("busy", "running"):
        response.status_code = 202
    row, ctx = await _view(session, view_id, user, claims, edit=False)
    return RefreshResult(
        outcome=outcome.outcome, detail=outcome.detail, diff=outcome.diff,
        membership=await membership_status(session, row, _definition_of(row), ctx),
    )
