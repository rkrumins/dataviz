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

import asyncio
import json
import logging
from contextlib import contextmanager
from typing import Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.auth.dependencies import requires
from backend.auth_service.interface import User
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning.cache_manager import acquire_lease, release_lease
from backend.app.services.versioning.messaging import nudge_projection
from backend.app.services.versioning.service import (
    ConcurrencyError,
    GraphVersioningService,
    MergeConflict,
    OntologyViolation,
)

logger = logging.getLogger(__name__)

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


_read_factory = None  # lazily built FalkorDB read-client factory (name -> graph)


def get_falkor_read_factory():
    """FalkorDB read-client factory for the hot traversal path (overridable in
    tests; returns ``None`` → reads fall back to Postgres)."""
    global _read_factory
    if _read_factory is None:
        try:
            from backend.app.services.versioning.projection import make_falkor_graph_factory
            _read_factory = make_falkor_graph_factory()
        except Exception as exc:   # pragma: no cover - infra
            logger.warning("FalkorDB read factory unavailable, reads use Postgres: %s", exc)
            _read_factory = False   # sentinel: tried and failed
    return _read_factory or None


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
    except OntologyViolation as exc:
        raise HTTPException(status_code=422, detail={"type": "ontology_violation", "violations": exc.violations})
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
    # Inline ontology vocabulary {entityTypes, edgeTypes} + strict|permissive.
    ontology_spec: Optional[dict] = Field(default=None, alias="ontologySpec")
    ontology_enforcement: Optional[str] = Field(default=None, alias="ontologyEnforcement")


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


class WatermarkModel(_ApiModel):
    committed: int       # main_head_commit_seq
    projected: int       # projection_state.projected_commit_seq
    fresh: bool          # projected >= committed


class StateResponse(_ApiModel):
    nodes: Dict[str, dict]
    edges: Dict[str, dict]
    watermark: Optional[WatermarkModel] = None


class GraphReadResponse(_ApiModel):
    source: str                       # "falkordb" | "postgres"
    watermark: WatermarkModel
    nodes: List[dict]
    edges: List[dict]


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
        ontology_spec=body.ontology_spec, ontology_enforcement=body.ontology_enforcement,
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
    with _domain_errors():
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
    state = await svc.materialize_state(graph_id=graph_id, branch_id=branch_id)
    wm = await svc.projection_watermark(graph_id)
    return {"nodes": state["nodes"], "edges": state["edges"],
            "watermark": {"committed": wm["committed"], "projected": wm["projected"], "fresh": wm["fresh"]}}


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


@router.get("/graphs/{graph_id}/graph/neighbors", response_model=GraphReadResponse)
async def graph_neighbors(
    ws_id: str, graph_id: str,
    urn: str = Query(..., description="seed node urn"),
    depth: int = Query(1, ge=1, le=20),
    direction: str = Query("both", pattern="^(out|in|both)$"),
    edge_types: Optional[str] = Query(None, alias="edgeTypes", description="comma-separated"),
    limit: int = Query(500, ge=1, le=5000),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    read_factory=Depends(get_falkor_read_factory),
):
    """Bounded neighborhood of a published-`main` node — FalkorDB-first (when the
    projection is caught up), Postgres fallback otherwise; every response carries
    the freshness watermark."""
    ets = [e for e in edge_types.split(",") if e] if edge_types else None
    return await _serve_neighbors(
        svc, read_factory, graph_id, urn=urn, depth=depth,
        direction=direction, edge_types=ets, limit=limit,
    )


async def _serve_neighbors(svc, read_factory, graph_id, *, urn, depth, direction, edge_types, limit):
    wm = await svc.projection_watermark(graph_id)
    wm_out = {"committed": wm["committed"], "projected": wm["projected"], "fresh": wm["fresh"]}
    can_falkor = bool(
        read_factory is not None and wm["status"] != "evicted" and wm["falkor_graph_name"]
        and wm["projected"] >= wm["committed"] - vconfig.READ_MAX_LAG
    )
    if can_falkor:
        await acquire_lease(graph_id)            # pin so an eviction sweep can't drop it mid-read
        try:
            result = await _falkor_neighbors(
                read_factory(wm["falkor_graph_name"]), urn=urn, depth=depth,
                direction=direction, edge_types=edge_types, limit=limit,
            )
            return {"source": "falkordb", "watermark": wm_out, **result}
        except Exception as exc:
            logger.warning("FalkorDB neighbors read failed for %s, PG fallback: %s", graph_id, exc)
        finally:
            await release_lease(graph_id)
    result = await svc.neighbors_from_state(
        graph_id=graph_id, urn=urn, depth=depth, direction=direction,
        edge_types=edge_types, limit=limit,
    )
    return {"source": "postgres", "watermark": wm_out, **result}


async def _falkor_neighbors(graph, *, urn, depth, direction, edge_types, limit):
    """Bounded neighborhood from the FalkorDB projection (validated against a real
    FalkorDB in the P6 integration tests)."""
    from backend.app.providers.falkordb_provider import _edge_from_row, _node_from_props
    d = int(depth)
    pat = {"out": f"(s)-[r*1..{d}]->(n)", "in": f"(s)<-[r*1..{d}]-(n)"}.get(direction, f"(s)-[r*1..{d}]-(n)")
    params = {"urn": urn, "limit": int(limit)}
    where = ""
    if edge_types:
        where = "WHERE ALL(rel IN r WHERE type(rel) IN $ets) "
        params["ets"] = list(edge_types)
    cypher = (
        f"MATCH (s {{urn:$urn}}) OPTIONAL MATCH {pat} {where}"
        f"WITH s, collect(DISTINCT n) AS ns "          # collect() drops nulls
        f"UNWIND ([s] + ns) AS x RETURN DISTINCT x LIMIT $limit"
    )
    res = await asyncio.wait_for(graph.query(cypher, params=params), timeout=10.0)
    nodes, node_urns = [], set()
    for row in (getattr(res, "result_set", None) or []):
        props = dict(row[0].properties)
        gn = _node_from_props(props)
        if gn is not None:
            nodes.append(gn.model_dump(by_alias=True))
            if props.get("urn"):
                node_urns.add(props["urn"])
    edges = []
    if node_urns:
        er = await asyncio.wait_for(graph.query(
            "MATCH (a)-[r]->(b) WHERE a.urn IN $urns AND b.urn IN $urns "
            "RETURN a.urn, b.urn, type(r), r", params={"urns": list(node_urns)}), timeout=10.0)
        for row in (getattr(er, "result_set", None) or []):
            edges.append(_edge_from_row(row[0], row[1], row[2], dict(row[3].properties)).model_dump(by_alias=True))
    return {"nodes": nodes, "edges": edges}


class BulkIngestResponse(_ApiModel):
    commit_id: Optional[str] = None
    commit_seq: Optional[int] = None
    ingested: int = 0
    nodes: int = 0
    edges: int = 0
    rejected: List[dict] = []
    idempotent_replay: bool = False


@router.post("/graphs/{graph_id}/bulk-ingest", response_model=BulkIngestResponse)
async def bulk_ingest(
    ws_id: str, graph_id: str,
    request: Request,
    background: BackgroundTasks,
    idempotency_key: Optional[str] = Query(None, alias="idempotencyKey"),
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Day-0 / large-delta import: POST an ndjson body (one node/edge per line) →
    one ``import`` commit. Invalid lines are reported, not fatal. Idempotent on
    ``idempotencyKey``. (Raw body streams; the object-store upload-URL flow for
    very large loads plugs in here.)"""
    rows: List[dict] = []
    content = await request.body()
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append({"kind": "__malformed__"})        # rejected by the service
    with _domain_errors():
        report = await svc.bulk_ingest(
            graph_id=graph_id, rows=rows, actor=user.id, idempotency_key=idempotency_key,
        )
    if report.get("commit_id"):
        background.add_task(nudge_projection, graph_id)
    return report


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
