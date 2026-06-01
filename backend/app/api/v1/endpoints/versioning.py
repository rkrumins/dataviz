"""HTTP API for the versioned graph store — the ONLY path between the frontend
and Postgres (plan §1, §13).  The browser never connects to Postgres (or
FalkorDB) directly; it speaks to this router, which delegates to
:class:`GraphVersioningService`, the sole owner of the ``graphver`` store.

Boundary policy
---------------
* **Workspace-scoped.** Mounted at ``/{ws_id}/versioning`` like the rest of the
  data plane (``graph.py``).  Every ``graph_id`` is verified to belong to
  ``{ws_id}`` (:func:`graph_in_workspace`) so a valid permission in one workspace
  can't reach another tenant's graph by guessing an id.
* **Authenticated + RBAC.** A versioned graph is 1:1 with a data source, so the
  operations reuse the existing data-source permissions:
    - reads  → ``workspace:datasource:read``
    - writes → ``workspace:datasource:manage``
  Forking + opening a PR need only ``read`` (anyone who can see a graph may fork
  it and propose changes); **merging** a PR into the base needs ``manage`` on the
  base's workspace — the governance gate (plan §12.5).
* **Typed contract.** camelCase request/response models; domain errors map to
  HTTP (merge conflict / integrity → 409 with the conflict set; unknown id → 404).
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.auth.dependencies import requires
from backend.auth_service.interface import User
from backend.app.services.versioning.messaging import nudge_projection
from backend.app.services.versioning.service import (
    ConcurrencyError,
    GraphVersioningService,
    MergeConflict,
)

router = APIRouter()

# Permission constants (a graph is a data source — reuse its perms).
_READ = "workspace:datasource:read"
_MANAGE = "workspace:datasource:manage"


# --------------------------------------------------------------------------- #
# Service + tenant-isolation dependencies                                      #
# --------------------------------------------------------------------------- #
_service = GraphVersioningService()


def get_versioning_service() -> GraphVersioningService:
    """Injectable service handle (overridable in tests)."""
    return _service


async def graph_in_workspace(
    ws_id: str,
    graph_id: str,
    svc: GraphVersioningService = Depends(get_versioning_service),
) -> dict:
    """Resolve a graph and assert it lives in ``ws_id`` — 404 (not 403) on a
    cross-tenant miss so graph existence doesn't leak across workspaces."""
    meta = await svc.get_graph(graph_id)
    if meta is None or meta["workspace_id"] != ws_id:
        raise HTTPException(status_code=404, detail="graph not found in workspace")
    return meta


async def pr_in_workspace(
    ws_id: str,
    pr_id: str,
    svc: GraphVersioningService = Depends(get_versioning_service),
) -> dict:
    """Resolve a PR and assert its **base** graph lives in ``ws_id`` (the merge is
    governed by the base owner's workspace)."""
    pr = await svc.get_pr(pr_id)
    if pr is None:
        raise HTTPException(status_code=404, detail="pull request not found")
    base = await svc.get_graph(str(pr["target_graph_id"]))
    if base is None or base["workspace_id"] != ws_id:
        raise HTTPException(status_code=404, detail="pull request not found in workspace")
    return pr


@contextmanager
def _domain_errors():
    """Translate service domain exceptions into HTTP responses."""
    try:
        yield
    except MergeConflict as exc:
        raise HTTPException(status_code=409, detail={"type": "merge_conflict", "conflicts": exc.conflicts})
    except ConcurrencyError as exc:
        raise HTTPException(status_code=409, detail={"type": "integrity", "message": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# --------------------------------------------------------------------------- #
# Models (camelCase wire, snake_case Python — matches the app convention)       #
# --------------------------------------------------------------------------- #
class _ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class CreateGraphRequest(_ApiModel):
    data_source_id: str = Field(alias="dataSourceId")
    workspace_id: str = Field(alias="workspaceId")
    kind: str = "manual"
    base_ontology_id: Optional[str] = Field(default=None, alias="baseOntologyId")
    tenant_id: Optional[str] = Field(default=None, alias="tenantId")
    # The data source's real FalkorDB graph name (so the existing reader sees
    # versioned data); omit to use a synthetic gv_<id> fallback.
    falkor_graph_name: Optional[str] = Field(default=None, alias="falkorGraphName")


class OpenDraftRequest(_ApiModel):
    name: Optional[str] = None
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")


class StageOp(_ApiModel):
    op: str = Field(description="create | update | delete")
    entity_kind: str = Field(alias="entityKind", description="node | edge")
    entity_id: Optional[str] = Field(default=None, alias="entityId")
    payload: Optional[dict] = None
    ref: Optional[str] = None
    change_reason: Optional[str] = Field(default=None, alias="changeReason")


class StageRequest(_ApiModel):
    ops: List[StageOp]


class CheckpointRequest(_ApiModel):
    message: Optional[str] = None


class PublishRequest(_ApiModel):
    message: str
    resolutions: Optional[Dict[str, Optional[dict]]] = None


class ForkRequest(_ApiModel):
    data_source_id: Optional[str] = Field(default=None, alias="dataSourceId")


class MergePrRequest(_ApiModel):
    message: str
    resolutions: Optional[Dict[str, Optional[dict]]] = None


class CreateGraphResponse(_ApiModel):
    graph_id: str = Field(alias="graphId")
    main_branch_id: str = Field(alias="mainBranchId")
    genesis_commit_id: str = Field(alias="genesisCommitId")


class GraphResponse(_ApiModel):
    graph_id: str = Field(alias="graphId")
    workspace_id: str = Field(alias="workspaceId")
    tenant_id: Optional[str] = Field(default=None, alias="tenantId")
    kind: str
    base_ontology_id: Optional[str] = Field(default=None, alias="baseOntologyId")
    fork_parent_graph_id: Optional[str] = Field(default=None, alias="forkParentGraphId")
    fork_base_commit_seq: Optional[int] = Field(default=None, alias="forkBaseCommitSeq")
    main_head_commit_seq: int = Field(alias="mainHeadCommitSeq")
    created_by: Optional[str] = Field(default=None, alias="createdBy")
    created_at: str = Field(alias="createdAt")


class BranchResponse(_ApiModel):
    branch_id: str = Field(alias="branchId")
    kind: str
    name: Optional[str] = None
    owner: Optional[str] = None
    status: str
    base_commit_seq: Optional[int] = Field(default=None, alias="baseCommitSeq")
    head_commit_id: Optional[str] = Field(default=None, alias="headCommitId")
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")
    created_by: Optional[str] = Field(default=None, alias="createdBy")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


class OpenDraftResponse(_ApiModel):
    branch_id: str = Field(alias="branchId")


class StageResponse(_ApiModel):
    assigned: Dict[str, str]
    count: int


class CheckpointResponse(_ApiModel):
    commit_id: Optional[str] = Field(default=None, alias="commitId")
    staged_changes: bool = Field(alias="stagedChanges")


class CommitResponse(_ApiModel):
    commit_id: str = Field(alias="commitId")


class StateResponse(_ApiModel):
    nodes: Dict[str, dict]
    edges: Dict[str, dict]


class MergePreviewResponse(_ApiModel):
    clean: bool
    conflicts: List[dict]
    changes: Dict[str, int]


class EntityHistoryResponse(_ApiModel):
    entity_id: str = Field(alias="entityId")
    versions: List[dict]


class DiffResponse(_ApiModel):
    added: List[str]
    removed: List[str]
    modified: Dict[str, dict]


class ForkResponse(_ApiModel):
    graph_id: str = Field(alias="graphId")
    main_branch_id: str = Field(alias="mainBranchId")
    fork_base_commit_seq: int = Field(alias="forkBaseCommitSeq")


class OpenPrResponse(_ApiModel):
    pr_id: str = Field(alias="prId")


class PrResponse(_ApiModel):
    pr_id: str = Field(alias="prId")
    graph_id: str = Field(alias="graphId")
    source_branch_id: str = Field(alias="sourceBranchId")
    target_graph_id: str = Field(alias="targetGraphId")
    target_branch: str = Field(alias="targetBranch")
    base_commit_seq: Optional[int] = Field(default=None, alias="baseCommitSeq")
    status: str
    conflicts: Optional[List[dict]] = None
    resulting_commit_id: Optional[str] = Field(default=None, alias="resultingCommitId")
    actor: Optional[str] = None
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


# --------------------------------------------------------------------------- #
# Graph lifecycle                                                              #
# --------------------------------------------------------------------------- #
@router.post("/graphs", response_model=CreateGraphResponse, status_code=status.HTTP_201_CREATED)
async def create_graph(
    ws_id: str,
    body: CreateGraphRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    if body.workspace_id != ws_id:
        raise HTTPException(status_code=400, detail="workspaceId must match the path workspace")
    return await svc.create_graph(
        data_source_id=body.data_source_id, workspace_id=ws_id, kind=body.kind,
        base_ontology_id=body.base_ontology_id, tenant_id=body.tenant_id, actor=user.id,
        falkor_graph_name=body.falkor_graph_name,
    )


@router.get("/graphs/{graph_id}", response_model=GraphResponse)
async def get_graph(
    ws_id: str, graph_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
):
    return meta


@router.get("/graphs/{graph_id}/branches", response_model=List[BranchResponse])
async def list_branches(
    ws_id: str, graph_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    return await svc.list_branches(graph_id=graph_id, limit=limit, offset=offset)


# --------------------------------------------------------------------------- #
# Draft editing                                                                #
# --------------------------------------------------------------------------- #
@router.post("/graphs/{graph_id}/branches", response_model=OpenDraftResponse, status_code=201)
async def open_draft(
    ws_id: str, graph_id: str, body: OpenDraftRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        branch_id = await svc.open_draft(
            graph_id=graph_id, owner=user.id, name=body.name,
            originating_view_id=body.originating_view_id,
        )
    return {"branch_id": branch_id}


@router.post("/graphs/{graph_id}/branches/{branch_id}/changes", response_model=StageResponse)
async def stage_changes(
    ws_id: str, graph_id: str, branch_id: str, body: StageRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    assigned = await svc.stage_changes(
        graph_id=graph_id, branch_id=branch_id, actor=user.id,
        ops=[op.model_dump(exclude_none=True) for op in body.ops],
    )
    return {"assigned": assigned, "count": len(body.ops)}


@router.post("/graphs/{graph_id}/branches/{branch_id}/commit", response_model=CheckpointResponse)
async def checkpoint(
    ws_id: str, graph_id: str, branch_id: str, body: CheckpointRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        commit_id = await svc.checkpoint(
            graph_id=graph_id, branch_id=branch_id, actor=user.id, message=body.message,
        )
    return {"commit_id": commit_id, "staged_changes": commit_id is not None}


@router.get("/graphs/{graph_id}/branches/{branch_id}/merge-preview", response_model=MergePreviewResponse)
async def merge_preview(
    ws_id: str, graph_id: str, branch_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.preview_merge(graph_id=graph_id, branch_id=branch_id)


@router.post("/graphs/{graph_id}/branches/{branch_id}/publish", response_model=CommitResponse)
async def publish(
    ws_id: str, graph_id: str, branch_id: str, body: PublishRequest,
    background: BackgroundTasks,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        commit_id = await svc.publish(
            graph_id=graph_id, branch_id=branch_id, actor=user.id,
            message=body.message, resolutions=body.resolutions,
        )
    background.add_task(nudge_projection, graph_id)   # post-commit, best-effort
    return {"commit_id": commit_id}


# --------------------------------------------------------------------------- #
# Reads / audit                                                                #
# --------------------------------------------------------------------------- #
@router.get("/graphs/{graph_id}/branches/{branch_id}/state", response_model=StateResponse)
async def get_state(
    ws_id: str, graph_id: str, branch_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    return await svc.materialize_state(graph_id=graph_id, branch_id=branch_id)


@router.get("/graphs/{graph_id}/entities/{entity_id}/history", response_model=EntityHistoryResponse)
async def get_entity_history(
    ws_id: str, graph_id: str, entity_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    return {"entity_id": entity_id, "versions": await svc.entity_history(graph_id=graph_id, entity_id=entity_id)}


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff", response_model=DiffResponse)
async def get_diff(
    ws_id: str, graph_id: str, branch_id: str,
    from_seq: int = Query(..., ge=0, alias="fromSeq"),
    to_seq: int = Query(..., ge=0, alias="toSeq"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    return await svc.diff_commits(graph_id=graph_id, branch_id=branch_id, from_seq=from_seq, to_seq=to_seq)


# --------------------------------------------------------------------------- #
# Forking + pull requests                                                      #
# --------------------------------------------------------------------------- #
@router.post("/graphs/{graph_id}/forks", response_model=ForkResponse, status_code=201)
async def fork_graph(
    ws_id: str, graph_id: str, body: ForkRequest,
    user: User = Depends(requires(_READ, workspace="ws_id")),       # read can fork
    meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.fork_graph(
            parent_graph_id=graph_id, workspace_id=ws_id, actor=user.id,
            data_source_id=body.data_source_id, tenant_id=meta.get("tenant_id"),
        )


@router.post("/graphs/{graph_id}/pulls", response_model=OpenPrResponse, status_code=201)
async def open_pull_request(
    ws_id: str, graph_id: str,
    user: User = Depends(requires(_READ, workspace="ws_id")),       # read can propose
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        pr_id = await svc.open_pr(source_graph_id=graph_id, actor=user.id)
    return {"pr_id": pr_id}


@router.get("/graphs/{graph_id}/pulls", response_model=List[PrResponse])
async def list_pull_requests(
    ws_id: str, graph_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    return await svc.list_pulls(target_graph_id=graph_id, limit=limit, offset=offset)


@router.get("/pulls/{pr_id}", response_model=PrResponse)
async def get_pull_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
):
    return pr


@router.get("/pulls/{pr_id}/preview", response_model=MergePreviewResponse)
async def preview_pull_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.preview_pr(pr_id=pr_id)


@router.post("/pulls/{pr_id}/merge", response_model=CommitResponse)
async def merge_pull_request(
    ws_id: str, pr_id: str, body: MergePrRequest,
    background: BackgroundTasks,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),     # only manage may merge into base
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        commit_id = await svc.merge_pr(
            pr_id=pr_id, actor=user.id, message=body.message, resolutions=body.resolutions,
        )
    background.add_task(nudge_projection, str(_pr["target_graph_id"]))   # base graph got the commit
    return {"commit_id": commit_id}
