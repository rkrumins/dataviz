"""HTTP API for the versioned graph store — the ONLY path between the frontend
and Postgres.

Architecture (plan §1, §13): the browser never connects to Postgres (or FalkorDB)
directly.  It speaks to this FastAPI router, which delegates to
:class:`GraphVersioningService`, which owns all access to the ``graphver`` store.
Reads are served the same way (and, once built, the FalkorDB projection sits
behind these same endpoints).

The acting user is taken from the :func:`current_actor` dependency.  Here it
reads the ``X-Actor`` header so the router is verifiable in isolation; when this
router is mounted in the full app, override it with the real auth dependency::

    app.dependency_overrides[current_actor] = get_current_user_id

so identity and workspace/RBAC scoping are enforced at the boundary.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from backend.app.services.versioning.service import (
    ConcurrencyError,
    GraphVersioningService,
    MergeConflict,
)

router = APIRouter()
_svc = GraphVersioningService()


# --------------------------------------------------------------------------- #
# Identity (override with real auth when mounted in the app)                   #
# --------------------------------------------------------------------------- #
async def current_actor(x_actor: Optional[str] = Header(default=None, alias="X-Actor")) -> str:
    if not x_actor:
        raise HTTPException(status_code=401, detail="missing actor (X-Actor header)")
    return x_actor


# --------------------------------------------------------------------------- #
# Request models                                                              #
# --------------------------------------------------------------------------- #
class CreateGraphRequest(BaseModel):
    data_source_id: str
    workspace_id: str
    kind: str = "manual"
    base_ontology_id: Optional[str] = None
    tenant_id: Optional[str] = None


class OpenDraftRequest(BaseModel):
    name: Optional[str] = None
    originating_view_id: Optional[str] = None


class StageOp(BaseModel):
    op: str = Field(description="create | update | delete")
    entity_kind: str = Field(description="node | edge")
    entity_id: Optional[str] = None
    payload: Optional[dict] = None
    ref: Optional[str] = None
    change_reason: Optional[str] = None


class StageRequest(BaseModel):
    ops: List[StageOp]


class CheckpointRequest(BaseModel):
    message: Optional[str] = None


class PublishRequest(BaseModel):
    message: str
    # entity_id -> resolved payload (or null to delete) for conflicted entities
    resolutions: Optional[Dict[str, Optional[dict]]] = None


# --------------------------------------------------------------------------- #
# Endpoints                                                                    #
# --------------------------------------------------------------------------- #
@router.post("/graphs", status_code=201)
async def create_graph(body: CreateGraphRequest, actor: str = Depends(current_actor)):
    return await _svc.create_graph(
        data_source_id=body.data_source_id,
        workspace_id=body.workspace_id,
        kind=body.kind,
        base_ontology_id=body.base_ontology_id,
        tenant_id=body.tenant_id,
        actor=actor,
    )


@router.post("/graphs/{graph_id}/branches", status_code=201)
async def open_draft(graph_id: str, body: OpenDraftRequest, actor: str = Depends(current_actor)):
    try:
        branch_id = await _svc.open_draft(
            graph_id=graph_id, owner=actor, name=body.name,
            originating_view_id=body.originating_view_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"branch_id": branch_id}


@router.post("/graphs/{graph_id}/branches/{branch_id}/changes")
async def stage_changes(graph_id: str, branch_id: str, body: StageRequest, actor: str = Depends(current_actor)):
    assigned = await _svc.stage_changes(
        graph_id=graph_id, branch_id=branch_id, actor=actor,
        ops=[op.model_dump(exclude_none=True) for op in body.ops],
    )
    return {"assigned": assigned, "count": len(body.ops)}


@router.post("/graphs/{graph_id}/branches/{branch_id}/commit")
async def checkpoint(graph_id: str, branch_id: str, body: CheckpointRequest, actor: str = Depends(current_actor)):
    try:
        commit_id = await _svc.checkpoint(
            graph_id=graph_id, branch_id=branch_id, actor=actor, message=body.message,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"commit_id": commit_id, "staged_changes": commit_id is not None}


@router.get("/graphs/{graph_id}/branches/{branch_id}/merge-preview")
async def merge_preview(graph_id: str, branch_id: str, _actor: str = Depends(current_actor)):
    try:
        return await _svc.preview_merge(graph_id=graph_id, branch_id=branch_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/graphs/{graph_id}/branches/{branch_id}/publish")
async def publish(graph_id: str, branch_id: str, body: PublishRequest, actor: str = Depends(current_actor)):
    try:
        commit_id = await _svc.publish(
            graph_id=graph_id, branch_id=branch_id, actor=actor,
            message=body.message, resolutions=body.resolutions,
        )
    except MergeConflict as exc:
        raise HTTPException(status_code=409, detail={"type": "merge_conflict", "conflicts": exc.conflicts})
    except ConcurrencyError as exc:
        raise HTTPException(status_code=409, detail={"type": "integrity", "message": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"commit_id": commit_id}


@router.get("/graphs/{graph_id}/branches/{branch_id}/state")
async def get_state(graph_id: str, branch_id: str, _actor: str = Depends(current_actor)):
    return await _svc.materialize_state(graph_id=graph_id, branch_id=branch_id)


@router.get("/graphs/{graph_id}/entities/{entity_id}/history")
async def get_entity_history(graph_id: str, entity_id: str, _actor: str = Depends(current_actor)):
    return {"entity_id": entity_id, "versions": await _svc.entity_history(graph_id=graph_id, entity_id=entity_id)}


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff")
async def get_diff(
    graph_id: str,
    branch_id: str,
    from_seq: int = Query(..., ge=0),
    to_seq: int = Query(..., ge=0),
    _actor: str = Depends(current_actor),
):
    return await _svc.diff_commits(
        graph_id=graph_id, branch_id=branch_id, from_seq=from_seq, to_seq=to_seq,
    )
