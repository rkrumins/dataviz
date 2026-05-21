"""User-authored versioned graph endpoints.

Mounted at ``/api/v1/{ws_id}/graphs`` (workspace-scoped, sibling to the
existing graph router). Authorization uses the existing
``requires("workspace:graph:...", workspace="ws_id")`` dependency
(permissions seeded by migration 20260516_1200_graph_permissions).

These endpoints use the **Graph Store** session
(:func:`get_graph_store_db_session`) — the decoupled system-of-record —
NOT the management session. The session scope commits on success, so
each mutating request is one atomic Graph Store transaction (blobs,
manifests, commit, audit, ref advance, outbox event).

Error contract (matches the frontend rebase/validation UX):
* head moved   -> 409 ``{detail:{code:"ref_moved", current_head}}``
* empty commit -> 409 ``{detail:{code:"empty_commit"}}``
* stale entity -> 409 ``{detail:{code:"stale_entity", violations:[
    {object_kind, object_id, expected_base_content_hash,
     observed_content_hash}, ...]}}``
* validation   -> 422 ``{detail:{code:"validation", violations:[...]}}``
* working set  -> 422 ``{detail:{code:"working_set_invalid", message}}``
* ontology     -> 422 ``{detail:{code:"ontology_missing"|"ontology_not_published",
                                 ontology_id}}``
* not found    -> 404

Strict-mode commits resolve the bound ontology from the management DB
(``OntologyORM``) into an :class:`OntologySpec` via
:func:`ontology_resolver.to_spec`. Schemaless graphs ignore the
management DB entirely (the path is opt-in per graph).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select

from backend.app.auth.dependencies import get_optional_user, requires
from backend.app.db.engine import get_db_session
from backend.app.db.graph_store_engine import get_graph_store_db_session
from backend.app.db.models import OntologyORM
from backend.app.db.repositories import graph_repo, graph_working_set_repo as ws_repo
from backend.app.db.repositories.graph_commit_repo import HeadMovedError
from backend.app.services.graph_authoring_engine import GraphAuthoringEngine
from backend.app.services.graph_outbox_relay import sse_subscribe
from backend.app.services.graph_versioning import (
    EmptyCommitError,
    GraphValidationError,
    OntologySpec,
)
from backend.app.services.graph_versioning.ontology_resolver import (
    OntologyNotFoundError,
    OntologyNotPublishedError,
    to_spec,
)
from backend.app.services.graph_versioning.snapshot_reader import (
    StaleBaseError,
    WorkingSetError,
)

router = APIRouter()


# ── DTOs ────────────────────────────────────────────────────────────

class CreateGraphRequest(BaseModel):
    name: str
    description: Optional[str] = None
    schema_mode: str = Field(default="schemaless", pattern="^(schemaless|strict)$")
    ontology_id: Optional[str] = None
    origin: str = Field(default="authored", pattern="^(authored|connected)$")
    source_data_source_id: Optional[str] = None


class GraphResponse(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: Optional[str]
    origin: str
    schema_mode: str
    default_branch: str
    head_commit_id: Optional[str] = None


class StageRequest(BaseModel):
    # Each: {change_type, object_kind, object_id, payload, summary?,
    #        base_content_hash?}
    changes: list[dict[str, Any]]
    expected_ws_version: Optional[int] = None


class CommitRequest(BaseModel):
    message: str
    expected_head_commit_id: Optional[str] = None


def _graph_response(g, head: Optional[str]) -> GraphResponse:
    return GraphResponse(
        id=g.id,
        workspace_id=g.workspace_id,
        name=g.name,
        description=g.description,
        origin=g.origin,
        schema_mode=g.schema_mode,
        default_branch=g.default_branch,
        head_commit_id=head,
    )


def _uid(user) -> str:
    return getattr(user, "id", None) or "anonymous"


# ── graph lifecycle ────────────────────────────────────────────────

@router.post("/{ws_id}/graphs", response_model=GraphResponse, status_code=201)
async def create_graph(
    ws_id: str = Path(...),
    body: CreateGraphRequest = Body(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    mgmt_session: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:create", workspace="ws_id")),
):
    # Strict mode requires an ontology that is (a) loadable from the
    # management DB and (b) published. The engine also enforces (a),
    # but checking at create time gives the user an immediate, precise
    # error instead of a 422 on first commit.
    if body.schema_mode == "strict":
        if not body.ontology_id:
            raise HTTPException(
                422,
                detail={
                    "code": "ontology_required",
                    "message": "strict schema_mode requires an ontology_id",
                },
            )
        await _load_ontology_spec(mgmt_session, body.ontology_id)
    g = await GraphAuthoringEngine.create_graph(
        session,
        workspace_id=ws_id,
        name=body.name,
        description=body.description,
        origin=body.origin,
        source_data_source_id=body.source_data_source_id,
        ontology_id=body.ontology_id,
        schema_mode=body.schema_mode,
        created_by=_uid(user),
    )
    return _graph_response(g, head=None)


async def _load_ontology_spec(
    mgmt_session: AsyncSession, ontology_id: str
) -> OntologySpec:
    """Cross-DB lookup + projection. Raises HTTPException 422 with a
    structured detail so the frontend can branch on the code."""
    row = (
        await mgmt_session.execute(
            select(OntologyORM).where(OntologyORM.id == ontology_id)
        )
    ).scalar_one_or_none()
    if row is None or row.deleted_at:
        raise HTTPException(
            422,
            detail={"code": "ontology_missing", "ontology_id": ontology_id},
        )
    if not row.is_published:
        raise HTTPException(
            422,
            detail={
                "code": "ontology_not_published",
                "ontology_id": ontology_id,
            },
        )
    return to_spec(row)


@router.get("/{ws_id}/graphs", response_model=list[GraphResponse])
async def list_graphs(
    ws_id: str = Path(...),
    limit: int = Query(50, le=200),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    graphs = await graph_repo.list_graphs(session, workspace_id=ws_id, limit=limit)
    out = []
    for g in graphs:
        ref = await graph_repo.get_branch_ref(
            session, graph_id=g.id, branch=g.default_branch
        )
        out.append(_graph_response(g, head=ref.commit_id))
    return out


@router.get("/{ws_id}/graphs/{graph_id}", response_model=GraphResponse)
async def get_graph(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    try:
        g = await graph_repo.get_graph(session, graph_id)
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})
    ref = await graph_repo.get_branch_ref(
        session, graph_id=g.id, branch=g.default_branch
    )
    return _graph_response(g, head=ref.commit_id)


@router.delete("/{ws_id}/graphs/{graph_id}", status_code=204)
async def delete_graph(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:delete", workspace="ws_id")),
):
    try:
        await graph_repo.soft_delete_graph(
            session, graph_id=graph_id, deleted_by=_uid(user)
        )
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})


# ── working set ────────────────────────────────────────────────────

@router.post("/{ws_id}/graphs/{graph_id}/branches/{branch}/stage")
async def stage_changes(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    body: StageRequest = Body(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:edit", workspace="ws_id")),
):
    try:
        version = await GraphAuthoringEngine.stage(
            session,
            graph_id=graph_id,
            branch=branch,
            user_id=_uid(user),
            changes=body.changes,
            actor=_uid(user),
        )
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})
    except ValueError as exc:
        raise HTTPException(422, detail={"code": "stage_invalid", "message": str(exc)})
    return {"ws_change_version": version}


@router.get("/{ws_id}/graphs/{graph_id}/branches/{branch}/working-set")
async def get_working_set(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    ref = await graph_repo.get_branch_ref(
        session, graph_id=graph_id, branch=branch
    )
    wset = await ws_repo.get_or_open(
        session,
        graph_id=graph_id,
        branch=branch,
        user_id=_uid(user),
        base_commit_id=ref.commit_id,
    )
    changes = await ws_repo.list_changes(session, working_set_id=wset.id)
    return {
        "base_commit_id": wset.base_commit_id,
        "ws_change_version": wset.ws_change_version,
        "changes": [
            {
                "change_type": c.change_type,
                "object_kind": c.object_kind,
                "object_id": c.object_id,
                "summary": c.summary,
                "after": c.after_blob,
            }
            for c in changes
        ],
    }


@router.delete("/{ws_id}/graphs/{graph_id}/branches/{branch}/working-set", status_code=204)
async def discard_working_set(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:edit", workspace="ws_id")),
):
    ref = await graph_repo.get_branch_ref(
        session, graph_id=graph_id, branch=branch
    )
    wset = await ws_repo.get_or_open(
        session,
        graph_id=graph_id,
        branch=branch,
        user_id=_uid(user),
        base_commit_id=ref.commit_id,
    )
    await ws_repo.discard_all(session, working_set=wset)


# ── commit / history / branches ────────────────────────────────────

@router.post("/{ws_id}/graphs/{graph_id}/branches/{branch}/commits")
async def commit(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    body: CommitRequest = Body(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    mgmt_session: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:commit", workspace="ws_id")),
):
    # Resolve the bound ontology for strict graphs before entering the
    # engine — the engine requires the spec to be passed in (it has no
    # management-DB session and stays cross-DB-decoupled).
    try:
        graph = await graph_repo.get_graph(session, graph_id)
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})
    ontology_spec: OntologySpec | None = None
    if graph.schema_mode == "strict":
        if not graph.ontology_id:
            raise HTTPException(
                422,
                detail={
                    "code": "ontology_required",
                    "message": "strict graph has no ontology_id bound",
                },
            )
        ontology_spec = await _load_ontology_spec(mgmt_session, graph.ontology_id)

    try:
        outcome = await GraphAuthoringEngine.commit(
            session,
            graph_id=graph_id,
            branch=branch,
            user_id=_uid(user),
            message=body.message,
            author=_uid(user),
            expected_head_commit_id=body.expected_head_commit_id,
            ontology=ontology_spec,
            actor=_uid(user),
        )
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})
    except HeadMovedError as exc:
        raise HTTPException(
            409,
            detail={"code": "ref_moved", "current_head": exc.current_head},
        )
    except EmptyCommitError:
        raise HTTPException(409, detail={"code": "empty_commit"})
    except StaleBaseError as exc:
        raise HTTPException(
            409,
            detail={
                "code": "stale_entity",
                "violations": [
                    {
                        "object_kind": v.object_kind,
                        "object_id": v.object_id,
                        "expected_base_content_hash": v.expected_base_content_hash,
                        "observed_content_hash": v.observed_content_hash,
                    }
                    for v in exc.violations
                ],
            },
        )
    except GraphValidationError as exc:
        raise HTTPException(
            422,
            detail={
                "code": "validation",
                "violations": [
                    {
                        "code": v.code,
                        "message": v.message,
                        "object_kind": v.object_kind,
                        "object_id": v.object_id,
                    }
                    for v in exc.violations
                ],
            },
        )
    except WorkingSetError as exc:
        raise HTTPException(
            422, detail={"code": "working_set_invalid", "message": str(exc)}
        )
    except ValueError as exc:
        raise HTTPException(
            422, detail={"code": "commit_invalid", "message": str(exc)}
        )
    r = outcome.result
    return {
        "commit_id": r.commit_id,
        "commit_hash": r.commit_hash,
        "root_hash": r.root_hash,
        "delta_summary": dict(r.delta_summary),
        "branch": outcome.branch,
    }


@router.get("/{ws_id}/graphs/{graph_id}/branches/{branch}/commits")
async def history(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    limit: int = Query(50, le=200),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    try:
        commits = await GraphAuthoringEngine.history(
            session, graph_id=graph_id, branch=branch, limit=limit
        )
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})
    return [
        {
            "commit_id": c.id,
            "commit_hash": c.commit_hash,
            "parent_ids": c.parent_ids or [],
            "author": c.author,
            "message": c.message,
            "delta_summary": c.delta_summary or {},
            "committed_at": c.committed_at,
        }
        for c in commits
    ]


class CreateBranchRequest(BaseModel):
    name: str
    from_commit_id: Optional[str] = None


@router.get("/{ws_id}/graphs/{graph_id}/branches/{branch}/events")
async def stream_branch_events(
    request: Request,
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Server-Sent Events stream for `(graph_id, branch)`.

    Emits `commit` events (and, when wired, `working_set_advanced`)
    so other tabs / users learn about new commits without polling.
    The relay already publishes the underlying events to Redis; this
    handler is a thin per-subscriber `XREAD BLOCK` fan-out. Honors
    the `Last-Event-ID` header for resume on reconnect.
    """
    last_event_id = request.headers.get("last-event-id")

    async def stream():
        async for frame in sse_subscribe(
            graph_id=graph_id,
            branch=branch,
            user_id=_uid(user),
            last_event_id=last_event_id,
        ):
            if await request.is_disconnected():
                break
            yield frame

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{ws_id}/graphs/{graph_id}/branches", status_code=201)
async def create_branch(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    body: CreateBranchRequest = Body(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:branch", workspace="ws_id")),
):
    ref = await graph_repo.create_branch(
        session,
        graph_id=graph_id,
        name=body.name,
        from_commit_id=body.from_commit_id,
        created_by=_uid(user),
    )
    return {"branch": ref.name, "commit_id": ref.commit_id}


__all__ = ["router"]
