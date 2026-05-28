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
from backend.app.db.repositories import (
    graph_repo,
    graph_store_outbox_repo,
    graph_working_set_repo as ws_repo,
)
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
from backend.app.services.view_binding_service import (
    ViewBindingError,
    ViewBranchMismatchError,
    ViewNotBoundError,
    assert_branch_matches_view,
)
from backend.app.db.models import ViewORM

router = APIRouter()


# ── DTOs ────────────────────────────────────────────────────────────

class CreateGraphRequest(BaseModel):
    name: str
    description: Optional[str] = None
    schema_mode: str = Field(default="schemaless", pattern="^(schemaless|strict)$")
    ontology_id: Optional[str] = None
    # Matches the DB CHECK in 0002_fork_and_pr; fork creation goes
    # through a dedicated endpoint (Phase 2.5) but the DTO must allow
    # the value so it round-trips through serialization.
    origin: str = Field(default="authored", pattern="^(authored|connected|fork)$")
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
    # Populated only when create-graph triggers an initial source sync
    # for an origin='connected' graph. Carries the resulting snapshot
    # row so the client can render "imported N nodes" or "import
    # failed" without a follow-up call.
    initial_source_snapshot: Optional[dict] = None


class StageRequest(BaseModel):
    # Each: {change_type, object_kind, object_id, payload, summary?,
    #        base_content_hash?}
    changes: list[dict[str, Any]]
    expected_ws_version: Optional[int] = None


class CommitRequest(BaseModel):
    message: str
    expected_head_commit_id: Optional[str] = None
    # Optional view binding context. When set, the commit endpoint:
    #   1. loads the view from the management DB,
    #   2. asserts it is bound to this graph and the requested branch
    #      matches the view's branching policy (defence against a
    #      client committing under the wrong audit context),
    #   3. stamps view_id on every graph_change_event row produced by
    #      this commit (per-view audit query is then a single indexed
    #      lookup).
    view_id: Optional[str] = None


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

    # Emit the authored-graph lifecycle event in the same Graph Store
    # transaction as the UserGraphORM insert. The authored-data-source
    # relay drains it from the graph.outbox Redis stream and projects
    # it into ``workspace_data_sources`` so the new graph appears in
    # the catalog and routes through the standard provider path.
    await graph_store_outbox_repo.emit(
        session,
        event_type="visualization.user_graph.created",
        aggregate_id=g.id,
        aggregate_type="user_graph",
        payload={
            "graph_id": g.id,
            "workspace_id": ws_id,
            "name": body.name,
            "description": body.description,
            "ontology_id": body.ontology_id,
            "schema_mode": body.schema_mode,
            "origin": body.origin,
            "created_by": _uid(user),
            "falkor_namespace": f"authored_{g.id}",
        },
    )

    # Connected/fork graphs: auto-trigger the initial source sync so
    # the canvas can open immediately. Inline this round (Phase 2.5
    # promotes to a background worker). Failures degrade gracefully —
    # the graph is created, the snapshot row carries status='failed'
    # + error_message, the canvas surfaces a "source sync failed,
    # retry?" banner.
    initial_snapshot = None
    if body.origin in ("connected",) and body.source_data_source_id:
        from backend.app.services import graph_source_sync_service
        try:
            initial_snapshot = await graph_source_sync_service.sync_data_source(
                session,
                graph_id=g.id,
                workspace_id=ws_id,
                source_data_source_id=body.source_data_source_id,
                triggered_by=_uid(user),
                mgmt_session=mgmt_session,
            )
        except graph_source_sync_service.ProviderResolveError:
            # Surface the create as success; the user can retry the
            # sync from the canvas's "source sync failed" banner.
            initial_snapshot = None

    response = _graph_response(g, head=None)
    if initial_snapshot is not None:
        response.initial_source_snapshot = {
            "id": initial_snapshot.id,
            "status": initial_snapshot.status,
            "added_count": initial_snapshot.added_count,
            "modified_count": initial_snapshot.modified_count,
            "removed_count": initial_snapshot.removed_count,
        }
    return response


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
    # Cross-DB delete fan-out via the same Redis-backed relay used on
    # create. Soft-deletes the matching ``workspace_data_sources`` row
    # so the authored graph disappears from the catalog.
    await graph_store_outbox_repo.emit(
        session,
        event_type="visualization.user_graph.deleted",
        aggregate_id=graph_id,
        aggregate_type="user_graph",
        payload={
            "graph_id": graph_id,
            "workspace_id": ws_id,
            "deleted_by": _uid(user),
            "falkor_namespace": f"authored_{graph_id}",
        },
    )


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


@router.post(
    "/{ws_id}/graphs/{graph_id}/branches/{branch}/working-set/pull"
)
async def pull_working_set(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:edit", workspace="ws_id")),
):
    """V1-6 functional pull: rebase the caller's working set against
    the current branch HEAD and surface any per-entity conflicts.

    Response shape:
    ```
    {
      "previous_base": "gcmt_OLD" | null,
      "new_base":      "gcmt_NEW" | null,
      "rebased":       <int>,   # staged ops that re-anchor cleanly
      "dropped":       <int>,   # delete/delete coincidences removed
      "conflicts": [
        {
          "object_kind": "node" | "edge",
          "object_id":   "...",
          "conflict_class": "edit_edit" | "edit_delete" |
                            "delete_edit" | "add_add",
          "base_content_hash":    "..." | null,
          "current_content_hash": "..." | null,
          "staged_change_type":   "update_node" | ...
        }, ...
      ]
    }
    ```

    Behavior contract:
    * Clean rebases stay in the working set with refreshed
      ``base_content_hash`` so a subsequent commit succeeds.
    * delete/delete coincidences silently drop from the working set.
    * Every other mismatch surfaces in ``conflicts`` with the staged
      op LEFT IN PLACE (original ``base_content_hash``) so the
      frontend can render the conflict and offer ours/theirs
      resolution without losing the user's work.
    * After pull, the working set's ``base_commit_id`` advances to
      the current branch HEAD; a subsequent ``POST /commits`` still
      enforces the head-CAS so a race with another concurrent
      commit returns ``409 ref_moved`` and the user pulls again.
    """
    try:
        graph = await graph_repo.get_graph(session, graph_id)
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})

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

    # Load the current HEAD's snapshot — the manifest carries every
    # (key -> content_hash) we need to compare against staged ops.
    new_snapshot = await graph_repo.load_snapshot(
        session, graph_id=graph_id, commit_id=ref.commit_id,
    )

    result = await ws_repo.rebase_against_snapshot(
        session,
        working_set=wset,
        new_base_commit_id=ref.commit_id,
        snapshot=new_snapshot,
    )
    return result


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

    # View-binding context (optional). When set, validate the view is
    # bound to this graph and the branch matches the view's policy —
    # rejects "alice committing under view A's audit context onto a
    # branch that belongs to view B" with 422.
    if body.view_id is not None:
        view = (
            await mgmt_session.execute(
                select(ViewORM).where(ViewORM.id == body.view_id)
            )
        ).scalar_one_or_none()
        if view is None or view.deleted_at:
            raise HTTPException(
                422,
                detail={"code": "view_missing", "view_id": body.view_id},
            )
        if view.source_graph_id != graph_id:
            raise HTTPException(
                422,
                detail={
                    "code": "view_graph_mismatch",
                    "view_id": body.view_id,
                    "expected_graph_id": view.source_graph_id,
                    "actual_graph_id": graph_id,
                },
            )
        try:
            assert_branch_matches_view(
                view, user_id=_uid(user), branch=branch,
            )
        except ViewBranchMismatchError as exc:
            raise HTTPException(
                422,
                detail={
                    "code": "view_branch_mismatch",
                    "view_id": body.view_id,
                    "expected_branch": exc.expected,
                    "actual_branch": exc.actual,
                },
            )

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
            view_id=body.view_id,
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


@router.get("/{ws_id}/graphs/{graph_id}/refs/{ref}/snapshot")
async def get_snapshot(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    ref: str = Path(..., description="Branch name or commit_id"),
    composed: Optional[bool] = Query(
        None,
        description=(
            "When the graph is connected/fork, default True returns "
            "source + enrichment composed. composed=false returns "
            "enrichment-only ('see only my edits' view). For authored "
            "graphs the flag is ignored (no source layer)."
        ),
    ),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Materialised node/edge state at *ref*, where ref is either a
    branch name or a commit_id.

    Response shape:
    ```
    {
      "ref": "view/<id>",
      "commit_id": "gcmt_…" | null,
      "root_hash": "…" | null,
      "nodes": [
        {"key": "...", "entity_type": "...", "display_name": "...",
         "position": {...}, "properties": {...}, "tags": [...],
         "content_hash": "..."},
        ...
      ],
      "edges": [
        {"key": "...", "source_key": "...", "target_key": "...",
         "edge_type": "...", "confidence": ..., "properties": {...},
         "content_hash": "..."},
        ...
      ]
    }
    ```
    O(graph) by design at this layer; Phase 1 add-on swaps for the
    streaming /manifest + /blobs:batch-get path.
    """
    try:
        graph = await graph_repo.get_graph(session, graph_id)
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})

    # Resolve ref → commit_id. Treat as a branch name first; fall back
    # to "is this a commit_id" so the same endpoint serves both shapes
    # (mirrors `git show <ref>`).
    branch_ref = await graph_repo.get_branch_ref_or_none(
        session, graph_id=graph_id, branch=ref,
    )
    if branch_ref is not None:
        commit_id = branch_ref.commit_id
    else:
        # Treat ref as a commit_id; verify it belongs to this graph.
        from backend.app.db.models_graph import GraphCommitORM
        commit = (
            await session.execute(
                select(GraphCommitORM).where(
                    GraphCommitORM.id == ref,
                    GraphCommitORM.graph_id == graph_id,
                )
            )
        ).scalar_one_or_none()
        if commit is None:
            raise HTTPException(404, detail={"code": "ref_not_found", "ref": ref})
        commit_id = commit.id

    nodes_by_key, edges_by_key = await graph_repo.load_graph_state(
        session, graph_id=graph_id, commit_id=commit_id,
    )

    # Re-derive content hashes so the client can cache by hash without
    # re-canonicalising on its side (and so future delta sync can
    # compare without a fetch).
    from backend.app.services.graph_versioning.content_address import (
        edge_content_hash,
        node_content_hash,
    )

    root_hash: str | None = None
    if commit_id:
        snap = await graph_repo.load_snapshot(
            session, graph_id=graph_id, commit_id=commit_id,
        )
        root_hash = snap.root_hash

    # Resolve compose-mode: default True for connected/fork graphs
    # (their canvas needs source + enrichment merged); always False
    # for authored graphs (no source layer to compose).
    is_layered = graph.origin in ("connected", "fork")
    effective_composed = bool(
        is_layered if composed is None else (composed and is_layered)
    )

    nodes_out: list[dict] = []
    edges_out: list[dict] = []
    diagnostics: dict | None = None

    if effective_composed:
        from backend.app.db.repositories import graph_source_repo
        from backend.app.services.graph_composition import (
            EnrichmentEdgeProjection,
            EnrichmentNodeProjection,
            SourceEdgeProjection,
            SourceNodeProjection,
            compose,
        )

        source_node_rows = await graph_source_repo.load_source_nodes(
            session, graph_id=graph_id,
        )
        source_edge_rows = await graph_source_repo.load_source_edges(
            session, graph_id=graph_id,
        )
        source_nodes = {
            urn: SourceNodeProjection(
                urn=urn,
                entity_type=r.entity_type,
                display_name=r.display_name,
                position=r.position,
                properties=dict(r.properties or {}),
                tags=tuple(r.tags or []),
            )
            for urn, r in source_node_rows.items()
        }
        source_edges = {
            urn: SourceEdgeProjection(
                urn=urn,
                source_urn=r.source_urn,
                target_urn=r.target_urn,
                edge_type=r.edge_type,
                properties=dict(r.properties or {}),
                tags=tuple(r.tags or []),
            )
            for urn, r in source_edge_rows.items()
        }
        enrichment_nodes = {
            k: EnrichmentNodeProjection(
                urn=k,
                entity_type=n.entity_type,
                display_name=n.display_name,
                position=n.position,
                properties=dict(n.properties),
                tags=tuple(n.tags),
                deleted=False,  # tombstones materialise as absent rows
            )
            for k, n in nodes_by_key.items()
        }
        enrichment_edges = {
            k: EnrichmentEdgeProjection(
                urn=k,
                source_urn=e.source_key,
                target_urn=e.target_key,
                edge_type=e.edge_type,
                properties=dict(e.properties),
                tags=(),
                deleted=False,
            )
            for k, e in edges_by_key.items()
        }
        composed_g = compose(
            source_nodes=source_nodes,
            source_edges=source_edges,
            enrichment_nodes=enrichment_nodes,
            enrichment_edges=enrichment_edges,
        )
        for urn, cn in composed_g.nodes.items():
            nodes_out.append({
                "key": urn,
                "entity_type": cn.entity_type,
                "display_name": cn.display_name,
                "position": cn.position,
                "properties": dict(cn.properties),
                "tags": list(cn.tags),
                "origin": cn.origin,
                "content_hash": node_content_hash(
                    entity_type=cn.entity_type,
                    display_name=cn.display_name,
                    position=cn.position,
                    properties=cn.properties,
                    tags=cn.tags,
                ),
            })
        for urn, ce in composed_g.edges.items():
            edges_out.append({
                "key": urn,
                "source_key": ce.source_urn,
                "target_key": ce.target_urn,
                "edge_type": ce.edge_type,
                "confidence": None,
                "properties": dict(ce.properties),
                "origin": ce.origin,
                "content_hash": edge_content_hash(
                    source_node_key=ce.source_urn,
                    target_node_key=ce.target_urn,
                    edge_type=ce.edge_type,
                    confidence=None,
                    properties=ce.properties,
                ),
            })
        d = composed_g.diagnostics
        diagnostics = {
            "nodes_suppressed_by_enrichment": d.nodes_suppressed_by_enrichment,
            "edges_suppressed_by_enrichment": d.edges_suppressed_by_enrichment,
            "edges_dropped_dangling": d.edges_dropped_dangling,
            "edges_dropped_endpoint_suppressed": d.edges_dropped_endpoint_suppressed,
        }
    else:
        for n in nodes_by_key.values():
            nodes_out.append({
                "key": n.key,
                "entity_type": n.entity_type,
                "display_name": n.display_name,
                "position": n.position,
                "properties": dict(n.properties),
                "tags": list(n.tags),
                "content_hash": node_content_hash(
                    entity_type=n.entity_type,
                    display_name=n.display_name,
                    position=n.position,
                    properties=n.properties,
                    tags=n.tags,
                ),
            })
        for e in edges_by_key.values():
            edges_out.append({
                "key": e.key,
                "source_key": e.source_key,
                "target_key": e.target_key,
                "edge_type": e.edge_type,
                "confidence": e.confidence,
                "properties": dict(e.properties),
                "content_hash": edge_content_hash(
                    source_node_key=e.source_key,
                    target_node_key=e.target_key,
                    edge_type=e.edge_type,
                    confidence=e.confidence,
                    properties=e.properties,
                ),
            })

    response = {
        "ref": ref,
        "commit_id": commit_id,
        "root_hash": root_hash,
        "composed": effective_composed,
        "nodes": nodes_out,
        "edges": edges_out,
    }
    if diagnostics is not None:
        response["composition_diagnostics"] = diagnostics
    return response


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


# ── time-travel (V1-9) ─────────────────────────────────────────────


@router.get("/{ws_id}/graphs/{graph_id}/as_of")
async def get_graph_as_of(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    at: str = Query(
        ...,
        description=(
            "ISO 8601 timestamp. Returns the snapshot at the closest "
            "trunk commit committed at or before this timestamp."
        ),
    ),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """V1-9 time-travel. Resolves a timestamp to the closest-prior
    trunk commit via ``graph_trunk_log`` (the V1-4 substrate) and
    returns its snapshot. Non-trunk history (drafts) is intentionally
    excluded — UC-5 is "what did the published graph look like at T?".
    """
    from backend.app.db.models_graph import GraphTrunkLogORM

    try:
        await graph_repo.get_graph(session, graph_id)
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "not_found"})

    row = (
        await session.execute(
            select(
                GraphTrunkLogORM.commit_id,
                GraphTrunkLogORM.committed_at,
            )
            .where(
                GraphTrunkLogORM.graph_id == graph_id,
                GraphTrunkLogORM.committed_at <= at,
            )
            .order_by(GraphTrunkLogORM.committed_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        raise HTTPException(
            404,
            detail={
                "code": "no_trunk_commit_at_or_before",
                "at": at,
            },
        )
    commit_id, committed_at = row
    nodes_by_key, edges_by_key = await graph_repo.load_graph_state(
        session, graph_id=graph_id, commit_id=commit_id,
    )
    return {
        "as_of": at,
        "commit_id": commit_id,
        "committed_at": committed_at,
        "nodes": [
            {
                "key": k,
                "entity_type": n.entity_type,
                "display_name": n.display_name,
                "position": n.position,
                "properties": n.properties,
                "tags": n.tags,
                "content_hash": n.content_hash,
            }
            for k, n in nodes_by_key.items()
        ],
        "edges": [
            {
                "key": k,
                "source_key": e.source_node_key,
                "target_key": e.target_node_key,
                "edge_type": e.edge_type,
                "confidence": e.confidence,
                "properties": e.properties,
                "content_hash": e.content_hash,
            }
            for k, e in edges_by_key.items()
        ],
    }


# ── audit / blame / diff (read endpoints) ──────────────────────────


@router.get("/{ws_id}/graphs/{graph_id}/audit")
async def get_graph_audit(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: Optional[str] = Query(
        None, description="Filter to a single branch (per-view scope)."
    ),
    view_id: Optional[str] = Query(
        None, description="Filter to a single view (uses the dedicated index)."
    ),
    object_kind: Optional[str] = Query(
        None, pattern="^(node|edge|graph|branch)$"
    ),
    actor: Optional[str] = Query(None),
    since: Optional[str] = Query(None, description="ISO timestamp."),
    limit: int = Query(100, le=500),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Per-source audit by default. ``?branch=`` narrows to a branch;
    ``?view_id=`` narrows to a view (the two filters can combine).

    Returns newest-first; each row carries actor/view_id/pr_id so a UI
    can render "alice in view A via PR #3 changed display_name on
    urn:foo at 2026-05-21T…".
    """
    from backend.app.db.models_graph import GraphChangeEventORM

    q = select(GraphChangeEventORM).where(
        GraphChangeEventORM.graph_id == graph_id
    )
    if branch:
        q = q.where(GraphChangeEventORM.branch == branch)
    if view_id:
        q = q.where(GraphChangeEventORM.view_id == view_id)
    if object_kind:
        q = q.where(GraphChangeEventORM.object_kind == object_kind)
    if actor:
        q = q.where(GraphChangeEventORM.actor == actor)
    if since:
        q = q.where(GraphChangeEventORM.created_at >= since)
    q = q.order_by(GraphChangeEventORM.created_at.desc()).limit(limit)
    rows = (await session.execute(q)).scalars().all()
    return {
        "graph_id": graph_id,
        "events": [
            {
                "id": r.id,
                "branch": r.branch,
                "commit_id": r.commit_id,
                "object_kind": r.object_kind,
                "object_id": r.object_id,
                "action": r.action,
                "attribute_path": r.attribute_path,
                "prev_content_hash": r.prev_content_hash,
                "new_content_hash": r.new_content_hash,
                "actor": r.actor,
                "view_id": r.view_id,
                "pr_id": r.pr_id,
                "created_at": r.created_at,
            }
            for r in rows
        ],
    }


@router.get("/{ws_id}/graphs/{graph_id}/objects/{urn:path}/blame")
async def get_object_blame(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    urn: str = Path(..., description="Node or edge key (URL-decoded)."),
    limit: int = Query(50, le=200),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Per-object audit chain. Drives BlamePanel: 'display_name set by
    alice in c1; tag pii added by bob in c2; …'. Returns newest-first.
    Uses the existing ``idx_gce_blame`` index."""
    from backend.app.db.models_graph import GraphChangeEventORM

    q = (
        select(GraphChangeEventORM)
        .where(
            GraphChangeEventORM.graph_id == graph_id,
            GraphChangeEventORM.object_id == urn,
        )
        .order_by(GraphChangeEventORM.created_at.desc())
        .limit(limit)
    )
    rows = (await session.execute(q)).scalars().all()
    return {
        "graph_id": graph_id,
        "object_id": urn,
        "events": [
            {
                "id": r.id,
                "branch": r.branch,
                "commit_id": r.commit_id,
                "action": r.action,
                "attribute_path": r.attribute_path,
                "prev_content_hash": r.prev_content_hash,
                "new_content_hash": r.new_content_hash,
                "actor": r.actor,
                "view_id": r.view_id,
                "pr_id": r.pr_id,
                "created_at": r.created_at,
            }
            for r in rows
        ],
    }


@router.get("/{ws_id}/graphs/{graph_id}/diff")
async def get_graph_diff(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    from_commit: str = Query(..., alias="from"),
    to_commit: str = Query(..., alias="to"),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Snapshot-level diff between two commits on the same graph.

    Pure Merkle diff via ``diff_snapshots`` (the same engine that
    powers the commit planner). Returns added/modified/removed entries
    per object kind; the client renders these with `isPending` styling.
    """
    from backend.app.services.graph_versioning.manifest import diff_snapshots

    try:
        from_snap = await graph_repo.load_snapshot(
            session, graph_id=graph_id, commit_id=from_commit,
        )
    except graph_repo.GraphNotFoundError:
        raise HTTPException(
            404, detail={"code": "commit_not_found", "commit_id": from_commit}
        )
    try:
        to_snap = await graph_repo.load_snapshot(
            session, graph_id=graph_id, commit_id=to_commit,
        )
    except graph_repo.GraphNotFoundError:
        raise HTTPException(
            404, detail={"code": "commit_not_found", "commit_id": to_commit}
        )

    d = diff_snapshots(from_snap, to_snap)
    return {
        "graph_id": graph_id,
        "from": from_commit,
        "to": to_commit,
        "added": [
            {"key": e.key, "kind": e.kind, "content_hash": e.content_hash}
            for e in d.added
        ],
        "modified": [
            {
                "key": new.key,
                "kind": new.kind,
                "prev_content_hash": old.content_hash,
                "new_content_hash": new.content_hash,
            }
            for old, new in d.modified
        ],
        "removed": [
            {"key": e.key, "kind": e.kind, "content_hash": e.content_hash}
            for e in d.removed
        ],
    }


# ── branch lifecycle ───────────────────────────────────────────────


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


# ── source-sync endpoints (Mode-2 / connected graphs) ─────────────


@router.post("/{ws_id}/graphs/{graph_id}/source/refresh")
async def refresh_source(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    source_data_source_id: Optional[str] = Query(
        None,
        description=(
            "Override the graph's bound source. Defaults to "
            "user_graphs.source_data_source_id."
        ),
    ),
    session: AsyncSession = Depends(get_graph_store_db_session),
    mgmt_session: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:edit", workspace="ws_id")),
):
    """Trigger an inline source-sync run for a connected graph.

    Resolves the upstream provider via the management DB's
    workspace_data_sources, streams nodes + edges, and applies the
    diff into ``graph_source_*`` tables. Returns the persisted
    snapshot row (``status='completed'`` on success, ``'failed'``
    with ``error_message`` on failure — the 5xx still propagates).

    MVP runs inline (no background worker). Cron-scheduled refresh +
    a dedicated worker process land in Phase 2.5.
    """
    from backend.app.services import graph_source_sync_service

    graph = await graph_repo.get_graph(session, graph_id)
    if graph.origin not in ("connected", "fork"):
        raise HTTPException(
            422,
            detail={
                "code": "graph_not_connected",
                "origin": graph.origin,
                "message": (
                    "source refresh only applies to connected/fork "
                    "graphs; authored graphs have no upstream source"
                ),
            },
        )

    ds_id = source_data_source_id or graph.source_data_source_id
    try:
        snapshot = await graph_source_sync_service.sync_data_source(
            session,
            graph_id=graph_id,
            workspace_id=graph.workspace_id,
            source_data_source_id=ds_id,
            triggered_by=_uid(user),
            mgmt_session=mgmt_session,
        )
    except graph_source_sync_service.ProviderResolveError as exc:
        raise HTTPException(
            422,
            detail={"code": "provider_resolve_failed", "detail": str(exc)},
        )

    return _snapshot_to_dict(snapshot)


@router.get("/{ws_id}/graphs/{graph_id}/source/snapshots")
async def list_source_snapshots(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    limit: int = Query(50, le=200),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """List recent source-refresh runs, newest first."""
    from backend.app.db.repositories import graph_source_repo

    rows = await graph_source_repo.list_snapshots(
        session, graph_id=graph_id, limit=limit,
    )
    return {
        "graph_id": graph_id,
        "snapshots": [_snapshot_to_dict(r) for r in rows],
    }


@router.get("/{ws_id}/graphs/{graph_id}/source/snapshots/{snapshot_id}")
async def get_source_snapshot(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    snapshot_id: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    from backend.app.db.repositories import graph_source_repo

    row = await graph_source_repo.get_snapshot(
        session, snapshot_id=snapshot_id,
    )
    if row is None or row.graph_id != graph_id:
        raise HTTPException(404, detail={"code": "snapshot_not_found"})
    return _snapshot_to_dict(row)


@router.get("/{ws_id}/graphs/{graph_id}/orphans")
async def list_graph_orphans(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    include_resolved: bool = Query(False),
    limit: int = Query(200, le=500),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Enrichment objects whose source URN vanished. Queue for human
    triage (drop / repoint / revive upstream)."""
    from backend.app.db.repositories import graph_source_repo

    rows = await graph_source_repo.list_orphans(
        session, graph_id=graph_id,
        include_resolved=include_resolved, limit=limit,
    )
    return {
        "graph_id": graph_id,
        "orphans": [
            {
                "id": r.id,
                "urn": r.urn,
                "object_kind": r.object_kind,
                "sync_run_id": r.sync_run_id,
                "discovered_at": r.discovered_at,
                "resolved_at": r.resolved_at,
                "resolved_by": r.resolved_by,
                "resolution": r.resolution,
            }
            for r in rows
        ],
    }


def _snapshot_to_dict(r) -> dict:
    return {
        "id": r.id,
        "graph_id": r.graph_id,
        "source_data_source_id": r.source_data_source_id,
        "status": r.status,
        "source_root_hash": r.source_root_hash,
        "added_count": r.added_count,
        "modified_count": r.modified_count,
        "removed_count": r.removed_count,
        "orphan_count": r.orphan_count,
        "error_message": r.error_message,
        "triggered_by": r.triggered_by,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
    }


# ── merge endpoints ────────────────────────────────────────────────


class MergePlanRequest(BaseModel):
    message: Optional[str] = None
    auto_commit_if_clean: bool = False


class MergeResolveRequest(BaseModel):
    # {object_id: {"kind": "node"|"edge", "content_hash": "..."} | null}
    # null = delete the object as the resolution.
    resolutions: dict[str, Optional[dict[str, str]]]
    message: Optional[str] = None


def _serialise_merge_plan(plan) -> dict:
    return {
        "merge_id": plan.merge_id,
        "graph_id": plan.graph_id,
        "source_branch": plan.source_branch,
        "target_branch": plan.target_branch,
        "base_commit_id": plan.base_commit_id,
        "source_commit_id": plan.source_commit_id,
        "target_commit_id": plan.target_commit_id,
        "status": plan.status,
        "has_no_conflicts": plan.has_no_conflicts,
        "has_no_integrity_violations": plan.has_no_integrity_violations,
        "is_mergeable": plan.is_mergeable,
        "auto_entry_count": plan.auto_entry_count,
        "conflicts": plan.conflicts,
        "integrity_violations": plan.integrity_violations,
        "result_commit_id": plan.result_commit_id,
        "delta_summary": dict(plan.delta_summary) if plan.delta_summary else None,
    }


@router.post(
    "/{ws_id}/graphs/{graph_id}/branches/{source}/merge-into/{target}"
)
async def merge_branch_into(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    source: str = Path(...),
    target: str = Path(...),
    body: MergePlanRequest = Body(default_factory=MergePlanRequest),
    session: AsyncSession = Depends(get_graph_store_db_session),
    mgmt_session: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:merge", workspace="ws_id")),
):
    """Plan (and optionally auto-commit) a three-way merge of *source*
    into *target* on the same graph.

    - ``auto_commit_if_clean=true`` + the plan is clean + integrity-
      clean → the merge commit is written inline; response carries
      ``status='committed'`` + ``result_commit_id``.
    - Otherwise the plan is persisted as ``status='open'`` with
      conflicts + integrity violations surfaced for the client to
      resolve via POST /merges/{id}/resolve.
    """
    from backend.app.services import graph_merge_service

    graph = await graph_repo.get_graph(session, graph_id)
    ontology_spec = None
    if graph.schema_mode == "strict" and graph.ontology_id:
        ontology_spec = await _load_ontology_spec(
            mgmt_session, graph.ontology_id,
        )

    try:
        plan = await graph_merge_service.plan_merge(
            session,
            graph_id=graph_id,
            source_branch=source,
            target_branch=target,
            user_id=_uid(user),
            message=body.message,
            auto_commit_if_clean=body.auto_commit_if_clean,
            ontology=ontology_spec,
        )
    except graph_repo.GraphNotFoundError as exc:
        raise HTTPException(404, detail={"code": "branch_not_found", "detail": str(exc)})
    except HeadMovedError:
        raise HTTPException(409, detail={"code": "head_moved"})
    except ValueError as exc:
        raise HTTPException(422, detail={"code": "invalid_merge", "detail": str(exc)})

    return _serialise_merge_plan(plan)


@router.get("/{ws_id}/graphs/{graph_id}/merges/{merge_id}")
async def get_merge(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    merge_id: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """Re-read a previously-planned merge: its current status,
    conflicts, and (when committed) the merge commit id."""
    from backend.app.db.models_graph import (
        GraphMergeORM,
        GraphMergeConflictORM,
    )

    merge = (
        await session.execute(
            select(GraphMergeORM).where(
                GraphMergeORM.id == merge_id,
                GraphMergeORM.graph_id == graph_id,
            )
        )
    ).scalar_one_or_none()
    if merge is None:
        raise HTTPException(404, detail={"code": "merge_not_found"})

    conflicts = (
        await session.execute(
            select(GraphMergeConflictORM).where(
                GraphMergeConflictORM.merge_id == merge_id
            )
        )
    ).scalars().all()

    return {
        "merge_id": merge.id,
        "graph_id": merge.graph_id,
        "source_branch": merge.source_branch,
        "target_branch": merge.target_branch,
        "base_commit_id": merge.base_commit_id,
        "source_commit_id": merge.source_commit_id,
        "target_commit_id": merge.target_commit_id,
        "status": merge.status,
        "result_commit_id": merge.result_commit_id,
        "conflicts": [
            {
                "object_kind": c.object_kind,
                "object_id": c.object_id,
                "conflict_class": c.conflict_class,
                "base_value": c.base_value,
                "source_value": c.source_value,
                "target_value": c.target_value,
                "resolution": c.resolution,
                "resolved_value": c.resolved_value,
                "resolved_by": c.resolved_by,
                "resolved_at": c.resolved_at,
            }
            for c in conflicts
        ],
        "created_by": merge.created_by,
        "created_at": merge.created_at,
        "updated_at": merge.updated_at,
    }


@router.post("/{ws_id}/graphs/{graph_id}/merges/{merge_id}/resolve")
async def resolve_merge(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    merge_id: str = Path(...),
    body: MergeResolveRequest = Body(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    mgmt_session: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:merge", workspace="ws_id")),
):
    """Apply caller-supplied resolutions to a merge plan and commit
    it. Re-runs three-way + integrity from scratch so any head
    advance during human-resolution time is picked up. Returns the
    committed plan or 422 if integrity violations remain."""
    from backend.app.services import graph_merge_service

    graph = await graph_repo.get_graph(session, graph_id)
    ontology_spec = None
    if graph.schema_mode == "strict" and graph.ontology_id:
        ontology_spec = await _load_ontology_spec(
            mgmt_session, graph.ontology_id,
        )

    # Translate API resolution shape → engine shape.
    engine_resolutions: dict[str, tuple[str, str] | None] = {}
    for key, value in body.resolutions.items():
        if value is None:
            engine_resolutions[key] = None
        else:
            engine_resolutions[key] = (value["kind"], value["content_hash"])

    try:
        plan = await graph_merge_service.commit_resolved_merge(
            session,
            merge_id=merge_id,
            resolutions=engine_resolutions,
            user_id=_uid(user),
            message=body.message,
            ontology=ontology_spec,
        )
    except graph_merge_service.MergeNotFoundError:
        raise HTTPException(404, detail={"code": "merge_not_found"})
    except graph_merge_service.MergeNotResolvableError as exc:
        raise HTTPException(
            422,
            detail={"code": "merge_not_resolvable", "detail": str(exc)},
        )
    except HeadMovedError:
        raise HTTPException(409, detail={"code": "head_moved"})
    except graph_repo.GraphNotFoundError as exc:
        raise HTTPException(404, detail={"code": "branch_not_found", "detail": str(exc)})

    return _serialise_merge_plan(plan)


@router.get("/{ws_id}/graphs/{graph_id}/branches")
async def list_branches(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    _=Depends(requires("workspace:graph:read", workspace="ws_id")),
):
    """All refs on a graph (branches + tags). Newest-touched first."""
    refs = await graph_repo.list_branches(session, graph_id=graph_id)
    return {
        "graph_id": graph_id,
        "branches": [
            {
                "name": r.name,
                "ref_type": r.ref_type,
                "commit_id": r.commit_id,
                "revision": r.revision,
                "is_protected": r.is_protected,
                "created_by": r.created_by,
                "created_at": r.created_at,
                "updated_at": r.updated_at,
            }
            for r in refs
        ],
    }


@router.delete(
    "/{ws_id}/graphs/{graph_id}/branches/{branch}", status_code=204
)
async def delete_branch(
    ws_id: str = Path(...),
    graph_id: str = Path(...),
    branch: str = Path(...),
    session: AsyncSession = Depends(get_graph_store_db_session),
    mgmt_session: AsyncSession = Depends(get_db_session),
    user=Depends(get_optional_user),
    _=Depends(requires("workspace:graph:delete", workspace="ws_id")),
):
    """Delete a branch ref. Guards (each returns structured 409):

    - cannot_delete_default: branch is the graph's default_branch
    - working_sets_open: at least one user has an open working set
    - views_bound: at least one View still has source_branch=<branch>

    Commits/blobs are content-addressed and untouched — only the ref
    row is removed. Emits visualization.branch.deleted outbox event.
    """
    # Cross-DB bound-view lookup (the repo can't query mgmt DB).
    bound_view_ids = list(
        (
            await mgmt_session.execute(
                select(ViewORM.id).where(
                    ViewORM.source_graph_id == graph_id,
                    ViewORM.source_branch == branch,
                    ViewORM.deleted_at.is_(None),
                )
            )
        ).scalars()
    )
    try:
        await graph_repo.delete_branch(
            session,
            graph_id=graph_id,
            branch=branch,
            bound_view_ids=bound_view_ids,
        )
    except graph_repo.BranchDeleteBlockedError as exc:
        raise HTTPException(409, detail={"code": exc.code, **exc.context})
    except graph_repo.GraphNotFoundError:
        raise HTTPException(404, detail={"code": "branch_not_found"})

    await graph_store_outbox_repo.emit(
        session,
        event_type="visualization.branch.deleted",
        aggregate_id=graph_id,
        payload={
            "graph_id": graph_id,
            "branch": branch,
            "actor": _uid(user),
        },
    )


__all__ = ["router"]
