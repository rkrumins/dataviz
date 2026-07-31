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
import dataclasses
import inspect
import json
import logging
import re
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.api.v1.capability_gate import require_ds_read_or_view
from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import data_source_repo
from backend.app.db.repositories.view_repo import resolve_user_ids
from backend.auth_service.interface import User
from backend.app.services.graph_cache import CacheScope, get_graph_cache
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.projection_target import repair_projection_target
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning.cache_manager import acquire_lease, release_lease
from backend.app.services.versioning.messaging import nudge_projection
from backend.app.services.versioning.service import (
    AccessDenied,
    ApprovalRequired,
    ConcurrencyError,
    GraphVersioningService,
    MergeConflict,
    NotUpToDate,
    OntologyViolation,
    PullRequestExists,
    Viewer,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Admin feature flags (Admin → Features) ────────────────────────────────────
#
# `graphExportEnabled` closes a real hole. An admin could turn OFF "Export layers"
# (`semanticLayerExportEnabled`), watch the page go green, and believe their lineage could not
# leave the product — while the graph DATA itself walked out through the export job and its
# download, which no flag covered. Locking the schema and leaving the data open is the kind of
# gap that only looks safe.
#
# The DOWNLOAD carries the gate as well as the job. Gating creation alone would stop new exports
# while an already-queued one stayed collectable: the file leaves anyway, and the admin thinks
# they shut the door.
_GATE_GRAPH_EXPORT = require_feature("graphExportEnabled")

# `blankModelsEnabled` is the provenance switch. A hand-drawn model looks exactly like a discovered
# one on the canvas, and once it's in the estate nobody downstream can tell which is which. Until
# now the only way to forbid it was to turn version control off entirely — which also took drafts,
# reviews and history with it, so nobody ever did.
_GATE_BLANK_MODELS = require_feature("blankModelsEnabled")

# Permission constants (a graph is a data source — reuse its perms).
_READ = "workspace:datasource:read"
_MANAGE = "workspace:datasource:manage"


async def viewer_ctx(
    ws_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> Viewer:
    """Who is asking, for scoping draft/PR reads: the caller's id + whether they hold
    ``datasource:manage`` in this workspace (managers see everything). Cheap — claims come from
    the token; no DB hit. Endpoints still keep their ``requires(_READ)`` gate for the baseline."""
    return Viewer(actor=user.id, can_manage=has_permission(claims, _MANAGE, workspace_id=ws_id))


# --------------------------------------------------------------------------- #
# Service + tenant-isolation dependencies                                      #
# --------------------------------------------------------------------------- #
_service = GraphVersioningService()


def get_versioning_service() -> GraphVersioningService:
    """Injectable service handle (overridable in tests)."""
    return _service


_read_factory = None  # lazily built FalkorDB read-client factory (name -> graph)


def get_falkor_read_factory():
    """FalkorDB graph factory for the hot traversal path AND the interactive projector
    (overridable in tests; returns ``None`` → reads fall back to Postgres). Contract:
    ``(name, provider_id=None) -> graph | awaitable`` — registry-backed, so each graph
    routes to its data source's pinned FalkorDB instance, env instance as fallback."""
    global _read_factory
    if _read_factory is None:
        try:
            from backend.app.providers.falkor_graph_registry import make_registry_graph_factory
            _read_factory = make_registry_graph_factory()
        except Exception:   # pragma: no cover - infra
            try:
                from backend.app.services.versioning.projection import make_falkor_graph_factory
                _read_factory = make_falkor_graph_factory()
                logger.warning("registry graph factory unavailable — using env FalkorDB instance")
            except Exception as exc:
                logger.warning("FalkorDB read factory unavailable, reads use Postgres: %s", exc)
                _read_factory = False   # sentinel: tried and failed
    return _read_factory or None


_projector = None  # lazily built FalkorDB projector for synchronous read-your-writes projection
_SYNC_PROJECTION_TIMEOUT_SECS = 10.0


def _get_projector():
    """Projector for synchronous projection after an interactive write, built once over the SAME
    cached FalkorDB pool as the read path. ``None`` when FalkorDB is unavailable → the caller defers
    to the async worker + Postgres read fallback."""
    global _projector
    if _projector is None:
        factory = get_falkor_read_factory()
        if factory is None:
            return None
        from backend.app.services.versioning.projection import FalkorProjector
        from backend.app.services.projection_target import (
            make_rollup_rebuild_hook, nudge_stats_after_projection,
            resolve_aggregation_edge_types,
        )

        def _agg_service():
            # Lazy app.state lookup (deferred import — main imports this module at startup).
            try:
                from backend.app.main import app as _app
                return getattr(_app.state, "aggregation_service", None)
            except Exception:                            # pragma: no cover - import shape
                return None

        # edge_types_resolver: the interactive post-merge projection is usually the FIRST (and,
        # once it advances the watermark, the ONLY) pass over a merge's window — without it the
        # merged lineage would never reach the :AGGREGATED rollups. on_rollups_stale: an
        # interactive FULL seed (e.g. after a repin) wipes the rollups with the graph, and the
        # async worker won't re-walk it once the watermark advances — queue the rebuild here too.
        _projector = FalkorProjector(
            factory, edge_types_resolver=resolve_aggregation_edge_types,
            on_rollups_stale=make_rollup_rebuild_hook(_agg_service),
            on_projected=nudge_stats_after_projection)
    return _projector


async def _repair_projection_target(graph_id: str) -> Optional[str]:
    """Ensure a graph projects into the data source's REAL FalkorDB graph (the one the canvas reads),
    not an orphan ``gv_<id>``. This lives at the app layer because only here can we read the data
    source's ``graph_name`` (the graphver store may be a separate DB). Self-heals graphs created
    before the name was injected. Returns a now-orphaned ``gv_*`` name to drop (else ``None``).
    Never raises — projection proceeds regardless. The async worker self-heals via the same shared
    resolver, injected into its projector (``FalkorProjector(target_resolver=...)``)."""
    return await repair_projection_target(get_versioning_service(), graph_id)


async def project_now(graph_id: str) -> None:
    """Refresh a graph's FalkorDB cache up to its committed head, run IN-PROCESS as a FastAPI
    background task right after a main-advancing write — so the cache catches up promptly without
    depending on a separate projection worker (the original "merge has no effect" cause). NEVER
    raises (the Postgres commit already landed). On any failure (FalkorDB down/slow/apply error) or
    when FalkorDB is unconfigured, defer to the async worker via ``nudge_projection``; the
    watermark-gated Postgres read fallback (and the "refreshing" badge) cover the brief window."""
    orphan = await _repair_projection_target(graph_id)   # pin projection to the real graph (self-heal)
    proj = _get_projector()
    if proj is None:
        await nudge_projection(graph_id)
        return
    try:
        await asyncio.wait_for(proj.project_graph(graph_id), _SYNC_PROJECTION_TIMEOUT_SECS)
        if orphan:                                       # the old gv_* copy is now unused — reclaim its RAM
            try:
                # Route the GRAPH.DELETE to the graph's PINNED instance. Without the
                # provider_id the factory falls back to the env-default instance —
                # the delete would miss the orphan (leaking its RAM) and, worse,
                # could delete a same-named graph that exists over there.
                wm = await get_versioning_service().projection_watermark(graph_id)
                await proj.drop_graph(orphan, wm.get("falkor_provider"))
            except Exception as exc:
                logger.warning("could not drop orphan projection graph %s: %s", orphan, exc)
    except Exception as exc:
        logger.warning("synchronous projection for %s failed; deferring to async worker: %s", graph_id, exc)
        await nudge_projection(graph_id)


# Per-graph in-process guard for EXPLICIT rebuilds: a full reseed is a long-running background
# task; a second concurrent one for the same graph is redundant load and would race the first's
# clean wipe. Check + add have no await between them, so they're atomic on the event loop.
_rebuild_inflight: set = set()


async def rebuild_now(graph_id: str) -> None:
    """Run an operator-requested FULL rebuild in-process, with a budget a real reseed can
    actually finish under (`REBUILD_SYNC_TIMEOUT_SECS`, default 15 min) — unlike `project_now`,
    whose 10s ceiling exists to keep post-write catch-ups snappy but cancels any non-trivial
    full reseed. NEVER raises: on failure/timeout `project_graph`'s own handler has already
    reset status→idle and recorded `last_error`, which the watermark endpoint now surfaces —
    the Data health UI converges to a terminal failed state instead of spinning forever."""
    if graph_id in _rebuild_inflight:
        return
    _rebuild_inflight.add(graph_id)
    try:
        proj = _get_projector()
        if proj is None:
            await nudge_projection(graph_id)             # worker deployments pick it up
            return
        await asyncio.wait_for(
            proj.project_graph(graph_id), vconfig.REBUILD_SYNC_TIMEOUT_SECS)
    except (Exception, asyncio.CancelledError) as exc:
        # `except Exception` alone would let the wait_for timeout (CancelledError, a
        # BaseException) escape into the BackgroundTasks runner unlogged — the old
        # silent-death mode of the 10s path. status/last_error are already reset by
        # project_graph's handler; here we only log and hand off to the async worker.
        logger.warning("explicit rebuild for %s did not complete: %s", graph_id, exc)
        try:
            await nudge_projection(graph_id)
        except Exception:                                # pragma: no cover - infra
            pass
    finally:
        _rebuild_inflight.discard(graph_id)


async def _bump_main_cache(graph_id: str) -> None:
    """Invalidate the canvas read-cache for a graph's MAIN after a main-advancing write, so a merged
    change (a delete included) shows immediately instead of being served stale from Redis for the
    cache TTL. Main reads are cached under branch="" (fresh hot path) and branch=main_id (stale
    Postgres fallback), so we bump both. Awaited (not backgrounded) so the client's next read can't
    race ahead of the invalidation. Never raises — invalidation must not fail the user's write."""
    try:
        svc = get_versioning_service()
        meta = await svc.get_graph(graph_id)
        ws = str(meta.get("workspace_id") or "") if meta else ""
        if not ws:
            return
        ds = str(meta.get("data_source_id") or "")
        main_id = await svc.main_branch_id(graph_id)
        cache = get_graph_cache()
        await cache.bump_generation(CacheScope(ws, ds, ""))
        await cache.bump_generation(CacheScope(ws, ds, main_id))
    except Exception as exc:
        logger.warning("read-cache invalidation for %s skipped: %s", graph_id, exc)


async def _touch_views_data_updated(graph_id: str, actor: str) -> None:
    """Stamp ``data_updated_at``/``data_updated_by`` on every live view of the graph's data
    source after a main-advancing write (publish / MR merge / fork-PR merge / revert), so
    Explorer's "last updated" reflects DATA changes, not just settings edits. One bulk indexed
    UPDATE (idx_view_data_source); awaited inline like ``_bump_main_cache``. Best-effort by
    contract — the graphver commit already landed and the management DB may be a separate
    instance (no 2PC), so a failure here logs and never fails the user's write; the staleness
    self-corrects on the next publish. Interactive main write-throughs (``/graph/changes`` on
    main) are deliberately excluded — the canvas requires a draft, so every user-visible data
    change reaches one of the four call sites."""
    try:
        svc = get_versioning_service()
        meta = await svc.get_graph(graph_id)
        ds = str(meta.get("data_source_id") or "") if meta else ""
        if not ds:
            return
        from sqlalchemy import select as sa_select, update as sa_update
        from backend.app.db.engine import get_async_session
        from backend.app.db.models import ViewORM, _now
        from backend.app.db.repositories import view_activity_repo
        async with get_async_session() as session:
            # Snapshot the affected views BEFORE the bulk update so we can fan
            # out a per-view "data_changed" activity event (the timeline's Data
            # channel — a graph publish/merge changed what this view shows).
            affected = (await session.execute(
                sa_select(ViewORM.id, ViewORM.workspace_id).where(
                    ViewORM.data_source_id == ds, ViewORM.deleted_at.is_(None),
                )
            )).all()
            await session.execute(
                sa_update(ViewORM)
                .where(ViewORM.data_source_id == ds, ViewORM.deleted_at.is_(None))
                # Self-assign updated_at so SQLAlchemy's column onupdate=_now does NOT
                # fire on this Core UPDATE — data freshness must not masquerade as a
                # settings edit (the whole reason these fields are separate).
                .values(data_updated_at=_now(), data_updated_by=actor,
                        updated_at=ViewORM.updated_at)
                .execution_options(synchronize_session=False)
            )
            for view_id, workspace_id in affected:
                await view_activity_repo.record_view_activity(
                    session, view_id=view_id, workspace_id=workspace_id,
                    action="data_changed", actor=actor,
                    summary="Underlying data updated",
                    changes={"graphId": graph_id},
                )
            await session.commit()
    except Exception as exc:
        logger.warning("view data-freshness stamp for %s skipped: %s", graph_id, exc)


async def _ensure_view_layout_overlay(view_id: Optional[str], branch_id: Optional[str]) -> None:
    """Snapshot a view's published base layout into its branch overlay when a draft is opened
    FOR that view — the fork-point base for the eventual 3-way layout promote (BSL Phase 6). On
    first open the overlay's effective layout EQUALS the base, so nothing changes for readers
    until the draft edits it. Idempotent: resuming an existing draft returns the existing row
    (no duplicate, base not re-snapshotted).

    Best-effort by contract, mirroring ``_touch_views_data_updated``: a draft opened off any
    particular view (``view_id`` absent) creates no overlay, and overlay bookkeeping — including
    ``ensure_overlay`` raising on a since-deleted view — must NEVER fail the user's draft open
    (the write path lazily ensures the overlay on first edit as the fallback)."""
    if not view_id or not branch_id:
        return
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.repositories import view_repo
        async with get_async_session() as session:
            await view_repo.ensure_overlay(session, view_id, branch_id)
            await session.commit()
    except Exception as exc:
        logger.warning("layout overlay ensure for view %s / branch %s skipped: %s",
                       view_id, branch_id, exc)


async def _drop_view_layout_overlays(branch_id: Optional[str]) -> None:
    """Discard a branch's layout overlays when its draft is abandoned — layout edits vanish with
    the draft (Git-like), so a later draft on the same view forks from the published base again.
    Best-effort, mirroring ``_touch_views_data_updated``."""
    if not branch_id:
        return
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.repositories import view_repo
        async with get_async_session() as session:
            await view_repo.drop_overlays_for_branch(session, branch_id)
            await session.commit()
    except Exception as exc:
        logger.warning("layout overlay drop for branch %s skipped: %s", branch_id, exc)


async def _promote_view_layout_overlay(branch_id: Optional[str], actor: str) -> None:
    """Fold a draft's layout overlay into the published base on publish / MR merge — the layer &
    assignment CREATES, UPDATES and DELETES the draft made are 3-way-merged (vs the fork-point base)
    into ``views.config`` so the published version reflects them, then the overlay is deleted. Runs
    AFTER the graphver commit lands; best-effort by contract (mirroring ``_touch_views_data_updated``:
    the management DB may be separate, no 2PC), so a failure logs and never fails the user's merge —
    the overlay simply stays until a later publish retries."""
    if not branch_id:
        return
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.repositories import view_repo
        async with get_async_session() as session:
            await view_repo.promote_overlays_for_branch(session, branch_id, actor=actor)
            await session.commit()
    except Exception as exc:
        logger.warning("layout overlay promote for branch %s skipped: %s", branch_id, exc)


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
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
) -> dict:
    """Resolve a PR and assert its **base** graph lives in ``ws_id`` (the merge is governed by the
    base owner's workspace) AND that the caller may see it — its author, an assigned reviewer, or a
    manager. A non-participant gets 404 (don't leak that the PR exists)."""
    pr = await svc.get_pr(pr_id)
    if pr is None:
        raise HTTPException(status_code=404, detail="pull request not found")
    base = await svc.get_graph(str(pr["target_graph_id"]))
    if base is None or base["workspace_id"] != ws_id:
        raise HTTPException(status_code=404, detail="pull request not found in workspace")
    if not (viewer.can_manage or pr.get("actor") == viewer.actor
            or viewer.actor in (pr.get("reviewers") or [])):
        raise HTTPException(status_code=404, detail="pull request not found in workspace")
    return pr


async def view_in_workspace(
    ws_id: str,
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Resolve a view (management DB) and assert it lives in ``ws_id`` — 404 on a cross-tenant
    miss. Views live in the management store, not the versioning store, so this is a separate
    lookup (no cross-store join); it returns the view's ``data_source_id`` for PR scoping."""
    from backend.app.db.models import ViewORM
    v = await session.get(ViewORM, view_id)
    if v is None or v.workspace_id != ws_id:
        raise HTTPException(status_code=404, detail="view not found in workspace")
    return {"view_id": v.id, "data_source_id": v.data_source_id, "workspace_id": v.workspace_id}


@contextmanager
def _domain_errors():
    """Translate service domain exceptions into HTTP responses."""
    try:
        yield
    except MergeConflict as exc:
        raise HTTPException(status_code=409, detail={"type": "merge_conflict", "conflicts": exc.conflicts})
    except OntologyViolation as exc:
        raise HTTPException(status_code=422, detail={"type": "ontology_violation", "violations": exc.violations})
    except AccessDenied as exc:
        raise HTTPException(status_code=403, detail={"type": "access_denied", "message": str(exc)})
    except ApprovalRequired as exc:
        raise HTTPException(status_code=409, detail={"type": "approval_required", "pending": exc.pending})
    except NotUpToDate as exc:
        raise HTTPException(status_code=409, detail={
            "type": "not_up_to_date", "branchId": exc.branch_id, "behindBy": exc.behind_by,
            "message": str(exc)})
    except PullRequestExists as exc:
        # Carries the EXISTING prId so the client can route the user to the review that already
        # covers this branch, rather than dead-ending them on "no".
        raise HTTPException(status_code=409, detail={
            "type": "pull_request_exists", "prId": exc.pr_id, "branchId": exc.branch_id,
            "title": exc.title, "message": str(exc)})
    except ConcurrencyError as exc:
        raise HTTPException(status_code=409, detail={"type": "integrity", "message": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


async def _live_containment_types(
    session: AsyncSession, workspace_id: Optional[str], data_source_id: Optional[str],
) -> List[str]:
    """The CURRENT ontology's containment edge types (live, never a stored snapshot, never
    hardcoded), driving the delete cascade on the provider-independent versioning write
    paths (checkpoint/sync). Resolved straight from the ontology service (management DB) —
    no provider needed, so it keeps the versioning store provider-independent. Best-effort:
    [] on failure, so the cascade still cleans the node + its own edges."""
    try:
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService
        ont = LocalOntologyService(SQLAlchemyOntologyRepository(session))
        resolved = await ont.resolve(workspace_id=workspace_id, data_source_id=data_source_id)
        return list(getattr(resolved, "containment_edge_types", None) or [])
    except Exception:
        logger.exception("containment-type resolution failed (ws=%s ds=%s)", workspace_id, data_source_id)
        return []


async def _pr_containment_types(svc, session, ws_id, pr) -> List[str]:
    """Containment edge types for a PR's hierarchical diff, resolved from the **base** graph's
    data source (the side the merge lands on)."""
    base = await svc.get_graph(str(pr["target_graph_id"]))
    return await _live_containment_types(session, ws_id, base.get("data_source_id") if base else None)


async def _live_ontology_rules(
    session: AsyncSession, workspace_id: Optional[str], data_source_id: Optional[str],
    *, fail_closed: bool = False,
):
    """The CURRENT assigned ontology's rich rules (``OntologyRules``) for the commit-boundary
    gate, or ``None`` when the data source has no *explicitly assigned* ontology — the
    system-default/introspection fallback layers must NOT retroactively gate legacy graphs
    that never opted into an ontology. Mirrors :func:`_live_containment_types` (live, never a
    stored snapshot). Best-effort ``None`` on failure — unless ``fail_closed`` (blank graphs
    are contractually strict; a write that can't resolve its rules must not slip through)."""
    if not data_source_id:
        return None
    try:
        from backend.app.db.repositories.data_source_repo import get_data_source_orm
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.rules import resolved_ontology_to_rules
        from backend.app.ontology.service import LocalOntologyService
        ds = await get_data_source_orm(session, data_source_id)
        if ds is None or not ds.ontology_id:
            if fail_closed:
                raise HTTPException(status_code=422, detail={
                    "type": "ontology_required",
                    "message": "This graph is ontology-governed but its data source has no "
                               "assigned ontology; assign one to resume editing."})
            return None
        ont = LocalOntologyService(SQLAlchemyOntologyRepository(session))
        resolved = await ont.resolve(workspace_id=workspace_id, data_source_id=data_source_id)
        return resolved_ontology_to_rules(resolved)
    except HTTPException:
        raise
    except Exception:
        logger.exception("ontology-rules resolution failed (ws=%s ds=%s)", workspace_id, data_source_id)
        if fail_closed:
            raise HTTPException(status_code=503, detail={
                "type": "ontology_unavailable",
                "message": "The ontology for this graph could not be resolved; writes are "
                           "blocked until it is available again."})
        return None


async def _pr_ontology_rules(svc, session, ws_id, pr):
    """Rich rules for a merge request, resolved from the **base** graph's data source
    (the side the merge lands on) — same scoping as :func:`_pr_containment_types`."""
    base = await svc.get_graph(str(pr["target_graph_id"]))
    return await _rules_for_meta(session, ws_id, base)


async def _rules_for_meta(session: AsyncSession, ws_id: str, meta: Optional[dict]):
    """Rules for a graph's data source from its ``graph_in_workspace`` meta;
    ``kind == 'blank'`` graphs fail closed (they are contractually ontology-governed),
    others degrade to ``None`` (legacy behavior)."""
    if not meta:
        return None
    return await _live_ontology_rules(
        session, ws_id, meta.get("data_source_id"),
        fail_closed=(meta.get("kind") == "blank"))


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
    # The FalkorDB provider/instance hosting this graph's cache; scopes per-provider
    # eviction budgeting. Omit for single-instance deployments (the "default" provider).
    falkor_provider: Optional[str] = Field(default=None, alias="falkorProvider")
    # Inline ontology vocabulary {entityTypes, edgeTypes} + strict|permissive.
    ontology_spec: Optional[dict] = Field(default=None, alias="ontologySpec")
    ontology_enforcement: Optional[str] = Field(default=None, alias="ontologyEnforcement")


class OpenDraftRequest(_ApiModel):
    name: Optional[str] = None
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")
    shared: bool = False


class BranchMemberRequest(_ApiModel):
    subject_type: str = Field(alias="subjectType", description="user | group")
    subject_id: str = Field(alias="subjectId")
    role: str = Field(description="viewer | editor | maintainer")


class UpdateBranchRequest(_ApiModel):
    """Patch a draft's metadata. Omitted fields are left unchanged; ``""`` clears name/description."""
    name: Optional[str] = None
    description: Optional[str] = None
    is_shared: Optional[bool] = Field(default=None, alias="isShared")


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
    resolutions: Optional[Dict[str, Optional[dict]]] = None


class PublishRequest(_ApiModel):
    message: str
    resolutions: Optional[Dict[str, Optional[dict]]] = None


class RevertRequest(_ApiModel):
    message: Optional[str] = None


class RestorePreviewResponse(_ApiModel):
    """Exact impact of restoring main to a commit (same compute as the write)."""
    commits_undone: int = Field(alias="commitsUndone")
    nodes: Dict[str, int]
    edges: Dict[str, int]


class RebaseRequest(_ApiModel):
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


class CreateBlankGraphRequest(_ApiModel):
    """Self-service blank lineage model: one call provisions the manual data source,
    the genesis-only versioned graph (strict, ontology-governed), and registers it
    with aggregation. ``graphName`` is the user-chosen PHYSICAL FalkorDB key the
    model lives under (validated: slug rules, reserved prefixes, per-provider
    uniqueness); omitted → a collision-proof ``blank_<ds_id>`` is minted."""
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    provider_id: str = Field(alias="providerId")
    ontology_id: str = Field(alias="ontologyId")
    graph_name: Optional[str] = Field(default=None, alias="graphName", max_length=64)


class GraphNameCheckResponse(_ApiModel):
    available: bool
    normalized: str
    reason: Optional[str] = None
    #: A free name when this one is taken (e.g. "data_lineage" -> "data_lineage_2").
    #: Advisory: provisioning re-checks under the advisory lock and is the authority.
    suggestion: Optional[str] = None


class BlankGraphResponse(_ApiModel):
    data_source_id: str = Field(alias="dataSourceId")
    graph_id: str = Field(alias="graphId")
    main_branch_id: str = Field(alias="mainBranchId")
    graph_name: str = Field(alias="graphName")
    label: str


class ResolveRequest(_ApiModel):
    data_source_id: str = Field(alias="dataSourceId")
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")


class DraftRefModel(_ApiModel):
    branch_id: str = Field(alias="branchId")
    head_commit_id: Optional[str] = Field(default=None, alias="headCommitId")
    base_commit_seq: Optional[int] = Field(default=None, alias="baseCommitSeq")
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")


class ResolveResponse(_ApiModel):
    graph_id: str = Field(alias="graphId")
    main_branch_id: str = Field(alias="mainBranchId")
    main_head_commit_seq: int = Field(alias="mainHeadCommitSeq")
    my_draft: Optional[DraftRefModel] = Field(default=None, alias="myDraft")
    # manual | authoritative | hybrid | blank — lets the UI distinguish a genesis-only
    # BLANK model (guided empty canvas) from a not-yet-seeded graph (bootstrap CTA).
    kind: str = "manual"
    # The in-flight (or failed) "enable version control" job, when the graph is still at
    # genesis — so a reload lands back on live progress instead of the enable CTA.
    bootstrap: Optional[dict] = None


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
    # id → display name for every actor id this item references (see _attach_user_names).
    user_names: Dict[str, str] = Field(default_factory=dict, alias="userNames")


class BranchResponse(_ApiModel):
    branch_id: str = Field(alias="branchId")
    kind: str
    name: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    is_shared: bool = Field(default=False, alias="isShared")
    status: str
    base_commit_seq: Optional[int] = Field(default=None, alias="baseCommitSeq")
    head_commit_id: Optional[str] = Field(default=None, alias="headCommitId")
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")
    created_by: Optional[str] = Field(default=None, alias="createdBy")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    # id → display name for every actor id this item references (see _attach_user_names).
    user_names: Dict[str, str] = Field(default_factory=dict, alias="userNames")


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
    # Projection lifecycle: idle | projecting | rebuilding | evicted. Only projecting/rebuilding mean
    # the cache is ACTIVELY catching up — the "refreshing…" badge keys off this, not bare staleness
    # (an idle-but-behind graph just means no FalkorDB worker is running; reads use Postgres).
    status: str = "idle"
    # Failure surface + live progress for the Data health tab: `target` is the seq the projection
    # is catching up TO; `last_error` is why the last pass stopped (idle && !fresh && last_error =
    # a failed rebuild, not a pending one); progress_* report an in-flight full reseed.
    target: int = 0
    last_error: Optional[str] = Field(default=None, alias="lastError")
    last_projected_at: Optional[str] = Field(default=None, alias="lastProjectedAt")
    progress_done: Optional[int] = Field(default=None, alias="progressDone")
    progress_total: Optional[int] = Field(default=None, alias="progressTotal")


class BranchFreshnessModel(_ApiModel):
    """Live collaboration signal: has main advanced under this draft (must it pull before publishing)?"""
    behind: bool
    behind_by: int = Field(alias="behindBy")
    main_head_commit_seq: int = Field(alias="mainHeadCommitSeq")
    base_commit_seq: int = Field(alias="baseCommitSeq")


class RebuildResponse(_ApiModel):
    started: bool                                        # a fresh full replay was requested
    already_running: bool = Field(alias="alreadyRunning")  # a projection/rebuild was in flight (no-op)
    watermark: WatermarkModel


class ReconcileRequest(_ApiModel):
    deep: bool = False           # also field-compare every cached node (full scan), not just id-sets


class DriftNodeSample(_ApiModel):
    entity_id: str = Field(alias="entityId")
    urn: Optional[str] = None
    display_name: Optional[str] = Field(default=None, alias="displayName")


class DriftMismatch(_ApiModel):
    entity_id: str = Field(alias="entityId")
    field: str
    pg: Any = None
    falkor: Any = None


class DriftReportModel(_ApiModel):
    """The reconciler's drift report — the contract the Data Health UI (PR-B3) reads. Mirrors
    :class:`~backend.app.services.versioning.reconcile.DriftReport` field-for-field (camelCase)."""
    graph_id: str = Field(alias="graphId")
    falkor_graph_name: Optional[str] = Field(default=None, alias="falkorGraphName")
    committed_seq: int = Field(alias="committedSeq")
    projected_seq: int = Field(alias="projectedSeq")
    status: str
    fresh: bool
    pg_nodes: int = Field(alias="pgNodes")
    pg_edges: int = Field(alias="pgEdges")
    falkor_nodes: int = Field(alias="falkorNodes")
    falkor_edges: int = Field(alias="falkorEdges")
    missing_nodes: List[DriftNodeSample] = Field(default_factory=list, alias="missingNodes")
    extra_nodes: List[DriftNodeSample] = Field(default_factory=list, alias="extraNodes")
    missing_edges: List[str] = Field(default_factory=list, alias="missingEdges")
    extra_edges: List[str] = Field(default_factory=list, alias="extraEdges")
    mismatched: List[DriftMismatch] = Field(default_factory=list)
    edge_mismatched: List[DriftMismatch] = Field(default_factory=list, alias="edgeMismatched")
    truncated: bool = False
    in_sync: bool = Field(alias="inSync")
    checked_at: str = Field(alias="checkedAt")
    duration_ms: int = Field(alias="durationMs")
    skipped_reason: Optional[str] = Field(default=None, alias="skippedReason")


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


class IncomingModel(_ApiModel):
    """What a pull brought in from ``main`` — the upstream commits folded into the draft and their
    NET effect on state. `branchId` + `fromSeq`/`toSeq` fully identify the window, so the client
    fetches the full field-level diff from `/diff-window` without needing any state of its own
    (`commit_seq` is per-branch, so the seqs are meaningless without the branch they belong to)."""
    branch_id: Optional[str] = Field(default=None, alias="branchId")
    commit_ids: List[str] = Field(default_factory=list, alias="commitIds")
    commit_count: int = Field(default=0, alias="commitCount")
    contributors: List[str] = Field(default_factory=list)
    stats: Dict[str, int] = Field(default_factory=dict)
    from_seq: int = Field(default=0, alias="fromSeq")
    to_seq: int = Field(default=0, alias="toSeq")


class RebaseResponse(_ApiModel):
    """The result of pulling latest into a draft.

    `changes` and `incoming` are DIFFERENT THINGS and were previously conflated (only the former
    existed): `changes` is how YOUR OWN edits had to be rewritten to sit on the new base — usually
    nothing — while `incoming` is what actually arrived from Published. Reporting only `changes`
    is why a pull could never tell the user what it had pulled."""
    clean: bool
    conflicts: List[dict] = Field(default_factory=list)
    changes: Dict[str, int] = Field(default_factory=dict)
    incoming: Optional[IncomingModel] = None
    base_commit_seq: Optional[int] = Field(default=None, alias="baseCommitSeq")
    already_up_to_date: bool = Field(default=False, alias="alreadyUpToDate")


class EntityHistoryResponse(_ApiModel):
    entity_id: str = Field(alias="entityId")
    versions: List[dict]
    # id → display name for every version's actor (see _attach_user_names).
    user_names: Dict[str, str] = Field(default_factory=dict, alias="userNames")


class CommitLogResponse(_ApiModel):
    commits: List[dict]
    # ONE wrapper-level map covering every commit's actor + contributors (this
    # response wraps a list, so the map hangs here rather than per commit dict).
    user_names: Dict[str, str] = Field(default_factory=dict, alias="userNames")


class DiffResponse(_ApiModel):
    added: List[str]
    removed: List[str]
    modified: Dict[str, dict]


class DiffEntry(_ApiModel):
    """One changed entity with whole-payload before/after — the canvas overlay
    renders added/removed entities in full (a removed node becomes a ghost), so
    ids alone (``DiffResponse``) are not enough."""
    entity_id: str = Field(alias="entityId")
    kind: str                              # "node" | "edge"
    before: Optional[dict] = None
    after: Optional[dict] = None


class DiffVsMainResponse(_ApiModel):
    added: List[DiffEntry]
    removed: List[DiffEntry]
    modified: List[DiffEntry]


class DiffTreeNode(_ApiModel):
    """One row in the hierarchical diff — a ``container`` (expandable, nests changed
    descendants), a ``bucket`` (a type/edgeType grouping of parent-less changes), or a
    ``leaf`` (a single changed entity with whole-payload before/after). ``childTotal`` > 0
    marks an expandable row (load via the children endpoint); ``counts`` is the rolled-up
    add/modify/remove tally for a group, or the single op for a leaf."""
    key: str                                              # entityId (container/leaf) or bucket key
    kind: str                                             # container | bucket | leaf
    entity_kind: str = Field(default="node", alias="entityKind")  # node | edge (relationship)
    label: str
    entity_type: Optional[str] = Field(default=None, alias="entityType")
    status: Optional[str] = None                          # added | modified | removed | unchanged
    counts: Dict[str, int]
    child_total: int = Field(alias="childTotal")
    deleted: bool = False
    before: Optional[dict] = None
    after: Optional[dict] = None


class DiffSummaryResponse(_ApiModel):
    """Top of the hierarchical diff: the capped top-level groups, the total group count, the
    global add/modify/remove counts (equal to the flat diff's), and an entityType impact
    rollup (``{"Table": 17, "Column": 40, ...}``) for the summary header."""
    groups: List[DiffTreeNode]
    group_total: int = Field(alias="groupTotal")
    counts: Dict[str, int]
    # Split of the global tally so the UI shows both dimensions: entities (nodes) vs relationships
    # (non-containment edges). ``impact`` is the entityType rollup for the entity summary line.
    entity_counts: Dict[str, int] = Field(default_factory=dict, alias="entityCounts")
    edge_counts: Dict[str, int] = Field(default_factory=dict, alias="edgeCounts")
    impact: Dict[str, int]


class DiffChildrenResponse(_ApiModel):
    entries: List[DiffTreeNode]
    total: int


class ViewPrCountResponse(_ApiModel):
    from_view: int = Field(alias="fromView")
    on_data_source: int = Field(alias="onDataSource")


class ForkResponse(_ApiModel):
    graph_id: str = Field(alias="graphId")
    main_branch_id: str = Field(alias="mainBranchId")
    fork_base_commit_seq: int = Field(alias="forkBaseCommitSeq")


class OpenPrRequest(_ApiModel):
    title: Optional[str] = None
    description: Optional[str] = None
    reviewers: Optional[List[str]] = None


class OpenMrRequest(_ApiModel):
    title: Optional[str] = None
    description: Optional[str] = None
    reviewers: Optional[List[str]] = None


class UpdatePrRequest(_ApiModel):
    """Edit a PR's title/description. A field left unset is untouched."""
    title: Optional[str] = None
    description: Optional[str] = None


class OpenPrResponse(_ApiModel):
    pr_id: str = Field(alias="prId")


class PrResponse(_ApiModel):
    pr_id: str = Field(alias="prId")
    graph_id: str = Field(alias="graphId")
    source_branch_id: str = Field(alias="sourceBranchId")
    # The source draft's owner/name — surfaced on the single-PR read so the review drawer can show
    # who owns the draft (only populated by GET /…/{pr_id}, not the list endpoints).
    source_branch_owner: Optional[str] = Field(default=None, alias="sourceBranchOwner")
    source_branch_name: Optional[str] = Field(default=None, alias="sourceBranchName")
    originating_view_id: Optional[str] = Field(default=None, alias="originatingViewId")
    target_graph_id: str = Field(alias="targetGraphId")
    target_branch: str = Field(alias="targetBranch")
    base_commit_seq: Optional[int] = Field(default=None, alias="baseCommitSeq")
    # Draft MR only: lags the target's main head and must pull latest before it can merge.
    behind: Optional[bool] = None
    behind_by: Optional[int] = Field(default=None, alias="behindBy")
    status: str
    title: Optional[str] = None
    description: Optional[str] = None
    conflicts: Optional[List[dict]] = None
    resulting_commit_id: Optional[str] = Field(default=None, alias="resultingCommitId")
    reviewers: Optional[List[str]] = None
    approved_by: Optional[List[str]] = Field(default=None, alias="approvedBy")
    approval_status: Optional[str] = Field(default=None, alias="approvalStatus")
    checks_status: Optional[dict] = Field(default=None, alias="checksStatus")
    actor: Optional[str] = None                                       # who raised it
    created_at: str = Field(alias="createdAt")                        # when raised
    updated_at: str = Field(alias="updatedAt")
    merged_at: Optional[str] = Field(default=None, alias="mergedAt")  # when + who merged
    merged_by: Optional[str] = Field(default=None, alias="mergedBy")
    # HOW it was merged: "review" (through this PR) or "direct_publish" (a manager published the
    # source branch straight to main, which lands the same changes and so resolves this PR). The UI
    # says so plainly rather than passing a bypassed review off as a reviewed merge.
    merged_via: Optional[str] = Field(default=None, alias="mergedVia")
    closed_at: Optional[str] = Field(default=None, alias="closedAt")  # when + who closed
    closed_by: Optional[str] = Field(default=None, alias="closedBy")
    # id → display name for every actor id this item references (see _attach_user_names).
    user_names: Dict[str, str] = Field(default_factory=dict, alias="userNames")


# --------------------------------------------------------------------------- #
# Actor-name resolution (endpoint-layer only)                                  #
# --------------------------------------------------------------------------- #
# The graphver store records actors as raw user ids; a SEPARATE management DB
# owns the ``users`` table (they may be different databases in prod), so ids are
# resolved to names HERE — one batched, deduped lookup per request over the
# request's management session — never as a cross-store join inside the service.
_ACTOR_ID_FIELDS = (
    "owner", "created_by", "actor", "merged_by", "closed_by", "source_branch_owner",
)
_ACTOR_ID_LIST_FIELDS = ("contributors", "reviewers", "approved_by")


def _collect_actor_ids(item: dict) -> set:
    """Every user id an item references, across its scalar (owner/actor/mergedBy/…)
    and list (contributors/reviewers/approvedBy) actor fields."""
    ids: set = set()
    for f in _ACTOR_ID_FIELDS:
        v = item.get(f)
        if v:
            ids.add(v)
    for f in _ACTOR_ID_LIST_FIELDS:
        for v in item.get(f) or ():
            if v:
                ids.add(v)
    return ids


async def _attach_user_names(
    session: AsyncSession, items: List[dict], *, wrapper: Optional[dict] = None,
) -> None:
    """Resolve the actor ids carried by ``items`` to display names and hang the
    result under ``user_names`` (wire ``userNames``): once on ``wrapper`` for the
    list-wrapping ``CommitLogResponse``, else per item for wrapper-less lists
    (branches, PRs). ONE batched lookup resolves every id across all items;
    ids that don't resolve are simply absent from the map(s)."""
    all_ids: set = set()
    for it in items:
        all_ids |= _collect_actor_ids(it)
    resolved = await resolve_user_ids(session, all_ids) if all_ids else {}
    names = {uid: disp for uid, (disp, _email) in resolved.items() if disp}
    if wrapper is not None:
        wrapper["user_names"] = names
        return
    for it in items:
        it["user_names"] = {uid: names[uid] for uid in _collect_actor_ids(it) if uid in names}


# --------------------------------------------------------------------------- #
# Graph lifecycle                                                              #
# --------------------------------------------------------------------------- #
@router.post("/graphs", response_model=CreateGraphResponse, status_code=status.HTTP_201_CREATED)
async def create_graph(
    ws_id: str,
    body: CreateGraphRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    if body.workspace_id != ws_id:
        raise HTTPException(status_code=400, detail="workspaceId must match the path workspace")
    # Default the FalkorDB provider to the data source's so the worker's RAM-budget
    # eviction scopes per provider; an explicit falkorProvider wins. Best-effort:
    # provider resolution is a non-critical eviction hint, so a missing data source
    # or a lookup error falls back to the "default" provider — never fails creation.
    falkor_provider = body.falkor_provider
    if falkor_provider is None:
        try:
            ds = await data_source_repo.get_data_source_orm(session, body.data_source_id)
            falkor_provider = ds.provider_id if ds else None
        except Exception:
            logger.debug("provider lookup failed for %s; using default", body.data_source_id, exc_info=True)
    return await svc.create_graph(
        data_source_id=body.data_source_id, workspace_id=ws_id, kind=body.kind,
        base_ontology_id=body.base_ontology_id, tenant_id=body.tenant_id, actor=user.id,
        falkor_graph_name=body.falkor_graph_name, falkor_provider=falkor_provider,
        ontology_spec=body.ontology_spec, ontology_enforcement=body.ontology_enforcement,
    )


# ── Physical graph naming (blank models) ─────────────────────────────────────
# The graph name IS the FalkorDB key the model projects into, and a full
# projection seed WIPES that key — a collision is destructive. Names are
# therefore validated centrally: slug rules, reserved system prefixes, and
# per-provider uniqueness across ALL workspaces (the DB unique constraint is
# only per-workspace), plus a best-effort live GRAPH.LIST check.
_GRAPH_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
_RESERVED_GRAPH_PREFIXES = ("gv_", "gvt_", "gvtest_", "blank_", "__fork_")


#: "data_lineage_2" -> ("data_lineage", 2). Lets a suggestion keep counting from an
#: already-numbered name instead of producing "data_lineage_2_2".
_NUMBERED_SUFFIX_RE = re.compile(r"^(?P<base>.+?)_(?P<n>\d+)$")
_MAX_GRAPH_NAME_LEN = 64


async def _taken_graph_names(
    session: AsyncSession, provider_id: str, base: str,
) -> set:
    """Every name on this connection that could collide with ``base`` or ``base_N``.

    Fetched in ONE pass so suggesting a free name doesn't re-run the whole
    availability check (and its live GRAPH.LIST) once per candidate.
    """
    from sqlalchemy import or_, select
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    like = f"{base}%"
    taken: set = set()

    rows = (await session.execute(
        select(WorkspaceDataSourceORM.graph_name, WorkspaceDataSourceORM.dedicated_graph_name)
        .where(
            WorkspaceDataSourceORM.provider_id == provider_id,
            # A tombstone must not reserve its graph name forever. The live
            # GRAPH.LIST pass below still guards the destructive case: while the
            # deleted source's key physically exists, the name stays taken.
            WorkspaceDataSourceORM.deleted_at.is_(None),
            or_(WorkspaceDataSourceORM.graph_name.ilike(like),
                WorkspaceDataSourceORM.dedicated_graph_name.ilike(like)),
        ))).all()
    for graph_name, dedicated in rows:
        for value in (graph_name, dedicated):
            if value:
                taken.add(str(value).strip().lower())

    cats = (await session.execute(
        select(CatalogItemORM.source_identifier).where(
            CatalogItemORM.provider_id == provider_id,
            CatalogItemORM.source_identifier.ilike(like),
        ))).scalars().all()
    taken.update(str(c).strip().lower() for c in cats if c)

    from backend.app.providers.falkor_graph_registry import list_graph_keys
    keys = await list_graph_keys(provider_id)
    if keys:
        taken.update(
            k.strip().lower() for k in keys
            if k and k.strip().lower().startswith(base)
        )
    return taken


def _next_free_graph_name(base: str, taken: set) -> Optional[str]:
    """First free ``base_N`` (N >= 2). None when the family is exhausted."""
    trimmed = base[: _MAX_GRAPH_NAME_LEN - 5] or base  # leave room for "_999"
    for n in range(2, 1000):
        candidate = f"{trimmed}_{n}"
        if len(candidate) > _MAX_GRAPH_NAME_LEN:
            return None
        if candidate not in taken:
            return candidate
    return None


async def _suggest_graph_name(
    session: AsyncSession, provider_id: str, normalized: str,
) -> Optional[str]:
    match = _NUMBERED_SUFFIX_RE.match(normalized)
    base = match.group("base") if match else normalized
    taken = await _taken_graph_names(session, provider_id, base)
    return _next_free_graph_name(base, taken)


async def _graph_name_availability(
    session: AsyncSession, provider_id: str, raw: str, *, suggest: bool = False,
) -> Dict[str, object]:
    """``{available, normalized, reason?, suggestion?}`` for a proposed graph name.

    The graph name IS the FalkorDB key the model projects into, and a projection
    seed WIPES that key — so a collision is destructive and this must never say
    "available" for a name anything else already owns. When ``suggest`` is set, a
    taken name also comes back with the first free ``<base>_<n>`` so the caller can
    offer it instead of making the user invent one.
    """
    from sqlalchemy import or_, select
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    normalized = (raw or "").strip().lower()
    if not _GRAPH_NAME_RE.match(normalized):
        return {"available": False, "normalized": normalized,
                "reason": "Use 3–64 characters: lowercase letters, numbers, '-' or '_', "
                          "starting with a letter or number."}
    if normalized.startswith(_RESERVED_GRAPH_PREFIXES) or normalized.endswith("_proj"):
        return {"available": False, "normalized": normalized,
                "reason": "Names starting with gv_, gvt_, blank_, __fork_ or ending in "
                          "_proj are reserved for the system."}

    async def _taken(reason: str) -> Dict[str, object]:
        out: Dict[str, object] = {"available": False, "normalized": normalized, "reason": reason}
        if suggest:
            out["suggestion"] = await _suggest_graph_name(session, provider_id, normalized)
        return out

    ds_taken = (await session.execute(
        select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.provider_id == provider_id,
            WorkspaceDataSourceORM.deleted_at.is_(None),
            or_(WorkspaceDataSourceORM.graph_name == normalized,
                WorkspaceDataSourceORM.dedicated_graph_name == normalized),
        ).limit(1))).scalar_one_or_none()
    if ds_taken:
        return await _taken("Another data source on this connection already uses this name.")
    cat_taken = (await session.execute(
        select(CatalogItemORM.id).where(
            CatalogItemORM.provider_id == provider_id,
            CatalogItemORM.source_identifier == normalized,
        ).limit(1))).scalar_one_or_none()
    if cat_taken:
        return await _taken("A catalogued graph on this connection already uses this name.")
    # Live key check — best-effort (None = unreachable → registry checks stand alone;
    # they cover every app-managed key, so only out-of-band keys slip past).
    from backend.app.providers.falkor_graph_registry import list_graph_keys
    keys = await list_graph_keys(provider_id)
    if keys is not None and normalized in keys:
        return await _taken("A graph with this name already exists on this connection.")
    return {"available": True, "normalized": normalized}


@router.get("/blank-graphs/name-check", response_model=GraphNameCheckResponse)
async def check_blank_graph_name(
    ws_id: str,
    provider_id: str = Query(..., alias="providerId"),
    graph_name: str = Query(..., alias="graphName"),
    _user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Live availability check for the wizard's graph-name field (same rules the
    provisioning endpoint enforces authoritatively). A taken name comes back with a
    free alternative so the wizard can auto-uniquify instead of asking the user to
    invent one."""
    return await _graph_name_availability(session, provider_id, graph_name, suggest=True)


@router.post("/blank-graphs", response_model=BlankGraphResponse,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(_GATE_BLANK_MODELS)])
async def create_blank_graph(
    ws_id: str,
    body: CreateBlankGraphRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Provision a blank, self-service lineage model in one call:

    1. a **manual data source** on the chosen FalkorDB provider — no catalog item, the
       assigned ontology bound, and a minted collision-proof ``graph_name``
       (``blank_<ds_id>``; a full projection seed wipes its named graph, so the physical
       key is never user-supplied);
    2. the **genesis-only versioned graph** (``kind="blank"``, strict enforcement) pinned
       to that name + provider — Postgres is the source of truth from the first edit;
    3. best-effort **aggregation registration** so readiness reporting and the
       publish→rollup pipeline are live from day one.

    Management and graphver may be separate DBs (no 2PC): the data source commits first
    and is compensated away if graph creation fails."""
    from backend.app.db.repositories import ontology_definition_repo, provider_repo
    from backend.common.models.management import DataSourceCreateRequest

    # 1) Provider must exist, be active, FalkorDB (Neo4j later), and workspace-permitted.
    prov = await provider_repo.get_provider_orm(session, body.provider_id)
    if prov is None or not prov.is_active:
        raise HTTPException(status_code=422, detail={
            "type": "provider_unsupported",
            "message": "The selected provider connection does not exist or is inactive."})
    if prov.provider_type != "falkordb":
        raise HTTPException(status_code=422, detail={
            "type": "provider_unsupported",
            "message": f"Blank models are FalkorDB-backed for now; '{prov.provider_type}' "
                       "providers are not supported yet."})
    try:
        permitted = json.loads(prov.permitted_workspaces or '["*"]')
    except Exception:
        permitted = ["*"]
    if "*" not in permitted and ws_id not in permitted:
        raise HTTPException(status_code=403, detail="provider not permitted in this workspace")

    # 1b) Provider must be REACHABLE, not merely enabled. A model is worthless if its
    #     backing store is down, and a full projection would fail — so refuse up front.
    #     First the cached breaker/warmup verdict (the SAME signal the UI's status dot
    #     shows, via resolve_provider_status — zero I/O); then, only when that signal is
    #     'unknown' (never warmed up), one bounded live probe so a genuinely-down but
    #     un-observed provider can't slip through.
    from backend.app.providers.manager import provider_manager as _provider_mgr
    from backend.app.providers.reachability import resolve_provider_status
    try:
        _breakers = _provider_mgr.report_provider_states()
    except Exception:
        _breakers = {}
    _warmup = getattr(_provider_mgr, "warmup_cache", {}) or {}
    _status, _status_err = resolve_provider_status(
        is_active=prov.is_active, provider_id=prov.id,
        breaker_states=_breakers, warmup_cache=_warmup)
    if _status == "unavailable":
        raise HTTPException(status_code=422, detail={
            "type": "provider_unreachable",
            "message": f"'{prov.name}' is currently offline ({_status_err or 'connection failed'}). "
                       "Reconnect it, then try again."})
    if _status == "unknown":
        # Never observed — probe live (bounded ~2.5s) rather than assume healthy.
        try:
            from backend.app.api.v1.endpoints.providers import _run_connectivity_probe
            _creds = await provider_repo.get_credentials(session, prov.id)
            try:
                _extra = json.loads(prov.extra_config) if prov.extra_config else None
            except (ValueError, TypeError):
                _extra = None
            _probe = await _run_connectivity_probe(
                provider_type=prov.provider_type, host=prov.host, port=prov.port,
                tls_enabled=prov.tls_enabled, creds=_creds, extra_config=_extra)
            if not _probe.success:
                raise HTTPException(status_code=422, detail={
                    "type": "provider_unreachable",
                    "message": f"'{prov.name}' could not be reached ({_probe.error or 'connection failed'}). "
                               "Check the connection, then try again."})
        except HTTPException:
            raise
        except Exception:
            # Probe machinery unavailable (e.g. import/config issue) — don't hard-fail
            # provisioning on a maybe-healthy provider; the cached gate already caught
            # confirmed-down providers, and the first projection surfaces real errors.
            logger.exception("blank-graph live reachability probe errored for %s", prov.id)

    # 2) Ontology must exist and be published — blank models are ontology-governed.
    ont = await ontology_definition_repo.get_ontology(session, body.ontology_id)
    if ont is None or getattr(ont, "deleted_at", None):
        raise HTTPException(status_code=404, detail="unknown ontology")
    if not ont.is_published:
        raise HTTPException(status_code=422, detail={
            "type": "ontology_not_published",
            "message": "Blank models must be built on a published ontology."})

    # 3) Manual data source. The physical graph name is the user's choice when given
    #    (validated + serialized under a per-(provider,name) advisory lock so two
    #    concurrent provisions can't race past the cross-workspace uniqueness check
    #    the DB constraint doesn't cover); otherwise a collision-proof
    #    ``blank_<ds_id>`` is minted.
    user_graph_name: Optional[str] = None
    if body.graph_name:
        from sqlalchemy import text as _sql_text
        await session.execute(_sql_text(
            "SELECT pg_advisory_xact_lock(hashtext(:k))"
        ), {"k": f"graph-name:{body.provider_id}:{body.graph_name.strip().lower()}"})
        verdict = await _graph_name_availability(
            session, body.provider_id, body.graph_name, suggest=True)
        if not verdict["available"]:
            # Someone took the name while this wizard was open. Hand back a free one
            # so the client can offer a single-click fix instead of a retry that can
            # only ever fail again. NEVER fall through to the existing graph: a
            # projection seed would wipe whatever lives under that key.
            raise HTTPException(status_code=422, detail={
                "type": "graph_name_unavailable",
                "message": verdict["reason"],
                "suggestion": verdict.get("suggestion"),
            })
        user_graph_name = str(verdict["normalized"])
    ds = await data_source_repo.create_data_source(session, ws_id, DataSourceCreateRequest(
        provider_id=body.provider_id, ontology_id=body.ontology_id,
        label=body.name, access_level="write"))
    row = await data_source_repo.get_data_source_orm(session, ds.id)
    graph_name = user_graph_name or f"blank_{row.id}"
    row.graph_name = graph_name
    row.source_mode = "managed"
    row.created_by = user.id
    await session.commit()

    # 4) Genesis-only versioned graph pinned to the minted name + provider.
    try:
        created = await svc.create_graph(
            data_source_id=ds.id, workspace_id=ws_id, kind="blank", actor=user.id,
            base_ontology_id=body.ontology_id, falkor_graph_name=graph_name,
            falkor_provider=body.provider_id, ontology_enforcement="strict",
            # A blank model HAS no source — WE mint its FalkorDB graph (`blank_<ds>`), so it is
            # ours to reclaim. This is the only user-facing case where a purge may drop the key.
            owns_falkor_graph=True)
    except Exception:
        logger.exception("blank-graph creation failed for ds=%s; compensating", ds.id)
        try:                                             # compensate: remove the orphan ds
            await data_source_repo.delete_data_source(session, ds.id)
            await session.commit()
        except Exception:                                # pragma: no cover - double fault
            logger.exception("compensating delete of ds=%s failed — orphan data source", ds.id)
        raise HTTPException(status_code=502, detail={
            "type": "provisioning_failed",
            "message": "The model's version store could not be created; nothing was kept."})

    # 5) Aggregation registration (best-effort, never fails provisioning): creates the
    #    data source's aggregation state row so readiness reads "configured" instead of
    #    "none", and wires the publish→rollup pipeline from day one. The projector's
    #    on_rollups_stale hook self-heals later if this is skipped.
    try:
        from backend.app.main import app as _app
        agg = getattr(_app.state, "aggregation_service", None)
        if agg is not None:
            from backend.app.services.aggregation.schemas import AggregationTriggerRequest
            await agg.trigger(
                ds.id,
                AggregationTriggerRequest(idempotency_key=f"blank-provision:{created['graph_id']}"),
                "onboarding", session)
    except Exception as exc:
        logger.info("blank-model aggregation registration skipped for ds=%s: %s", ds.id, exc)

    return {"data_source_id": ds.id, "graph_id": created["graph_id"],
            "main_branch_id": created["main_branch_id"], "graph_name": graph_name,
            "label": body.name}


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
    view_id: Optional[str] = Query(None, alias="viewId"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Branches on the graph — graph-wide (every view) by default; ``viewId`` narrows to
    that view's own branches (the Data-Source rollup stays the default, unfiltered)."""
    branches = await svc.list_branches(
        graph_id=graph_id, limit=limit, offset=offset, viewer=viewer,
        originating_view_id=view_id)
    await _attach_user_names(session, branches)
    return branches


@router.get("/resolve", response_model=ResolveResponse)
async def resolve_graph_get(
    ws_id: str,
    data_source_id: str = Query(..., alias="dataSourceId"),
    view_id: Optional[str] = Query(None, alias="viewId"),
    # Membership OR view capability: the read-only canvas boot needs
    # branch resolution, and ``viewId`` is already a first-class param
    # here (branch-per-view). The only versioning endpoint open to
    # capability callers — history/diff surfaces stay membership-only.
    user: User = Depends(require_ds_read_or_view),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Resolve (workspace, dataSource) → versioned graph + the caller's open draft, if
    any, scoped to ``viewId`` when given (branch-per-view). Read-only: never opens a
    draft. 404 when no versioned graph backs the source."""
    res = await svc.resolve_graph(
        data_source_id=data_source_id, actor=user.id, workspace_id=ws_id,
        open_draft_if_absent=False, originating_view_id=view_id,
    )
    if res is None:
        raise HTTPException(status_code=404, detail="no versioned graph for data source")
    return await _with_bootstrap(res, data_source_id, ws_id)


async def _with_bootstrap(res: dict, data_source_id: str, ws_id: str) -> dict:
    """Attach the enablement job when the graph is still at genesis — the only window in
    which one can exist, so the lookup costs nothing on a live graph."""
    if int(res.get("main_head_commit_seq") or 0) > 1:
        return res
    from backend.app.services.versioning.bootstrap_worker import bootstrap_status
    job = await bootstrap_status(data_source_id=data_source_id, workspace_id=ws_id)
    if job is not None and job.get("status") in ("pending", "running", "failed"):
        return {**res, "bootstrap": job}
    return res


@router.post("/resolve", response_model=ResolveResponse)
async def resolve_graph_open(
    ws_id: str, body: ResolveRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Resolve and ensure the caller has an open draft to edit on (opens one if none)."""
    res = await svc.resolve_graph(
        data_source_id=body.data_source_id, actor=user.id, workspace_id=ws_id,
        open_draft_if_absent=True, originating_view_id=body.originating_view_id,
    )
    if res is None:
        raise HTTPException(status_code=404, detail="no versioned graph for data source")
    draft = res.get("my_draft")
    await _ensure_view_layout_overlay(
        body.originating_view_id, draft.get("branch_id") if draft else None)
    return res


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
            originating_view_id=body.originating_view_id, shared=body.shared,
        )
    await _ensure_view_layout_overlay(body.originating_view_id, branch_id)
    return {"branch_id": branch_id}


@router.get("/graphs/{graph_id}/branches/{branch_id}/members")
async def list_branch_members(
    ws_id: str, graph_id: str, branch_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return {"members": await svc.list_branch_members(graph_id=graph_id, branch_id=branch_id)}


@router.post("/graphs/{graph_id}/branches/{branch_id}/members")
async def add_branch_member(
    ws_id: str, graph_id: str, branch_id: str, body: BranchMemberRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.add_branch_member(
            graph_id=graph_id, branch_id=branch_id, subject_type=body.subject_type,
            subject_id=body.subject_id, role=body.role, actor=user.id,
        )


@router.delete("/graphs/{graph_id}/branches/{branch_id}/members/{subject_type}/{subject_id}")
async def remove_branch_member(
    ws_id: str, graph_id: str, branch_id: str, subject_type: str, subject_id: str,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        await svc.remove_branch_member(
            graph_id=graph_id, branch_id=branch_id, subject_type=subject_type,
            subject_id=subject_id, actor=user.id,
        )
    return {"removed": True}


@router.post("/graphs/{graph_id}/branches/{branch_id}/changes", response_model=StageResponse)
async def stage_changes(
    ws_id: str, graph_id: str, branch_id: str, body: StageRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    rules = await _rules_for_meta(session, ws_id, _meta)
    with _domain_errors():
        assigned = await svc.stage_changes(
            graph_id=graph_id, branch_id=branch_id, actor=user.id,
            ops=[op.model_dump(exclude_none=True) for op in body.ops],
            ontology_rules=rules,
        )
    return {"assigned": assigned, "count": len(body.ops)}


@router.post("/graphs/{graph_id}/branches/{branch_id}/commit", response_model=CheckpointResponse)
async def checkpoint(
    ws_id: str, graph_id: str, branch_id: str, body: CheckpointRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    rules = await _rules_for_meta(session, ws_id, _meta)
    with _domain_errors():
        commit_id = await svc.checkpoint(
            graph_id=graph_id, branch_id=branch_id, actor=user.id, message=body.message,
            resolutions=body.resolutions, containment_edge_types=cset,
            ontology_rules=rules,
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
    session: AsyncSession = Depends(get_db_session),
):
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    rules = await _rules_for_meta(session, ws_id, _meta)
    with _domain_errors():
        commit_id = await svc.publish(
            graph_id=graph_id, branch_id=branch_id, actor=user.id,
            message=body.message, resolutions=body.resolutions,
            containment_edge_types=cset, ontology_rules=rules,
        )
    await _bump_main_cache(graph_id)             # main advanced — invalidate stale canvas reads now
    await _touch_views_data_updated(graph_id, user.id)   # views' "data updated" freshness
    await _promote_view_layout_overlay(branch_id, user.id)   # fold the draft's layer/assignment edits into the published view
    background.add_task(project_now, graph_id)   # refresh FalkorDB in-process after commit (async); read-fallback + badge cover the window
    return {"commit_id": commit_id}


@router.post("/graphs/{graph_id}/branches/{branch_id}/abandon", response_model=BranchResponse)
async def abandon_draft(
    ws_id: str, graph_id: str, branch_id: str,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        result = await svc.abandon_draft(graph_id=graph_id, branch_id=branch_id, actor=user.id)
    await _drop_view_layout_overlays(branch_id)   # layout edits vanish with the draft (Git-like)
    return result


@router.patch("/graphs/{graph_id}/branches/{branch_id}", response_model=BranchResponse)
async def update_branch(
    ws_id: str, graph_id: str, branch_id: str, body: UpdateBranchRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Edit a draft's name / description / shared-visibility (owner or maintainer)."""
    with _domain_errors():
        return await svc.update_branch(
            graph_id=graph_id, branch_id=branch_id, actor=user.id,
            name=body.name, description=body.description, is_shared=body.is_shared,
        )


@router.post("/graphs/{graph_id}/branches/{branch_id}/rebase", response_model=RebaseResponse)
async def rebase_draft(
    ws_id: str, graph_id: str, branch_id: str, body: RebaseRequest,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Pull the latest ``main`` into a draft ("update branch"). Returns ``{clean, conflicts, changes,
    incoming, baseCommitSeq, alreadyUpToDate}``; on ``clean: false`` the client resolves the conflicts
    and resubmits with ``resolutions``.

    NOTE this route had NO response_model, so it returned the service's raw snake_case dict — while
    the client typed the fields as camelCase. `baseCommitSeq` and `alreadyUpToDate` were therefore
    always `undefined` on the client, which is why "Pull latest" claimed it had pulled changes even
    when the draft was already up to date. The model puts the wire back on the camelCase contract
    every other route here follows."""
    with _domain_errors():
        return await svc.rebase_draft(
            graph_id=graph_id, branch_id=branch_id, actor=user.id, resolutions=body.resolutions,
        )


@router.get("/graphs/{graph_id}/watermark", response_model=WatermarkModel)
async def get_watermark(
    ws_id: str, graph_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Projection freshness for ``main`` — drives the "refreshing…" badge cheaply (no state materialised)."""
    return _watermark_model(await svc.projection_watermark(graph_id))


@router.get("/graphs/{graph_id}/branches/{branch_id}/freshness", response_model=BranchFreshnessModel)
async def get_branch_freshness(
    ws_id: str, graph_id: str, branch_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Live "is this draft behind main?" signal — O(1), safe to poll frequently while editing so a
    branch owner learns RIGHT AWAY (not at merge) that a teammate published and they must pull."""
    with _domain_errors():
        f = await svc.branch_freshness(graph_id=graph_id, branch_id=branch_id)
    return BranchFreshnessModel(behind=f["behind"], behind_by=f["behind_by"],
                                main_head_commit_seq=f["main_head_commit_seq"],
                                base_commit_seq=f["base_commit_seq"])


def _watermark_model(wm: dict) -> WatermarkModel:
    return WatermarkModel(committed=wm["committed"], projected=wm["projected"],
                          fresh=wm["fresh"], status=wm["status"],
                          target=wm.get("target", 0),
                          last_error=wm.get("last_error"),
                          last_projected_at=wm.get("last_projected_at"),
                          progress_done=wm.get("progress_done"),
                          progress_total=wm.get("progress_total"))


@router.post("/graphs/{graph_id}/projection/rebuild", response_model=RebuildResponse)
async def rebuild_projection(
    ws_id: str, graph_id: str,
    background: BackgroundTasks,
    _user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Force a full replay of committed ``main`` from Postgres (the SoR) into the graph's FalkorDB
    cache — the "rebuild the cache" operator action. Pins an unpinned graph to its data source's
    real graph first; 409 if there is still no FalkorDB target (nothing to rebuild). Idempotent: a
    projection/rebuild already in flight returns ``started=false``/``alreadyRunning=true`` untouched.
    The catch-up runs in-process as a background task (same path publish/merge use) and is scheduled
    ALWAYS — even when ``started=false`` — so a stranded 'projecting'/'rebuilding' status on a
    worker-less deployment self-heals (``project_now`` is an idempotent catch-up, a no-op when the
    cache is already fresh)."""
    await _repair_projection_target(graph_id)            # self-heal: pin an unpinned graph when possible
    wm = await svc.projection_watermark(graph_id)
    name = wm.get("falkor_graph_name")
    # No real target — NULL or the synthetic ``gv_<id>`` placeholder nothing reads (mirrors the
    # projector's unpinned skip). Nothing is cached, so there is nothing to rebuild.
    if not name or name == f"gv_{graph_id}":
        raise HTTPException(status_code=409, detail="no FalkorDB projection target for this graph")
    started = await svc.request_projection_rebuild(graph_id)
    # Schedule the catch-up unconditionally: even on the already-in-flight (started=False) path,
    # rebuild_now is an idempotent catch-up (and self-deduplicates per graph), so a status
    # stranded by a lost worker self-heals. Unlike project_now's 10s interactive ceiling, the
    # rebuild budget (REBUILD_SYNC_TIMEOUT_SECS) lets a real full reseed actually finish.
    background.add_task(rebuild_now, graph_id)
    return RebuildResponse(started=started, already_running=not started,
                           watermark=_watermark_model(await svc.projection_watermark(graph_id)))


# Per-graph in-process guard: a reconcile is a request-scoped full scan; a second concurrent one
# for the same graph is redundant load, so it 409s rather than double-scanning. Check + add have no
# await between them, so they're atomic on the event loop (no lock needed).
_reconcile_inflight: set = set()


@router.post("/graphs/{graph_id}/projection/reconcile", response_model=DriftReportModel)
async def reconcile_projection(
    ws_id: str, graph_id: str, body: ReconcileRequest,
    _user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
):
    """Validate that ALL committed ``main`` in Postgres is present in the FalkorDB cache — a
    streamed, full-coverage drift report (counts + id-set diff, plus a deep field check when
    ``deep=true``). Request-scoped (no job infra); a concurrent reconcile for the same graph 409s."""
    if graph_id in _reconcile_inflight:
        raise HTTPException(status_code=409, detail="reconcile already running")
    _reconcile_inflight.add(graph_id)
    try:
        from backend.app.services.versioning import db as vdb
        from backend.app.services.versioning.reconcile import ProjectionReconciler
        # Reconcile against the SAME FalkorDB graphs the reader reads (the projector builds its own
        # client from this very factory), over the graphver session scope.
        reconciler = ProjectionReconciler(vdb.graphver_session, get_falkor_read_factory())
        try:
            report = await reconciler.reconcile(graph_id, deep=body.deep)
        except Exception as exc:
            # The reconcile scans the FalkorDB read layer directly; a connection/query failure there
            # is an availability blip, not a server bug — surface a clean 503 so the Data Health UI
            # says "try again shortly" instead of showing a raw 500.
            logger.warning("reconcile scan failed for %s: %s", graph_id, exc)
            raise HTTPException(
                status_code=503, detail="fast read layer is unreachable — try again shortly")
    finally:
        _reconcile_inflight.discard(graph_id)
    return DriftReportModel.model_validate(dataclasses.asdict(report))


@router.post("/graphs/{graph_id}/commits/{commit_id}/revert", response_model=CommitResponse)
async def revert_commit(
    ws_id: str, graph_id: str, commit_id: str, body: RevertRequest,
    background: BackgroundTasks,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),   # writing main is privileged
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        new_commit_id = await svc.revert_commit(
            graph_id=graph_id, commit_id=commit_id, actor=user.id, message=body.message,
        )
    await _bump_main_cache(graph_id)             # main advanced — invalidate stale canvas reads now
    await _touch_views_data_updated(graph_id, user.id)   # views' "data updated" freshness
    background.add_task(project_now, graph_id)   # refresh FalkorDB in-process after commit (async); read-fallback + badge cover the window
    return {"commit_id": new_commit_id}


@router.post("/graphs/{graph_id}/commits/{commit_id}/restore", response_model=CommitResponse)
async def restore_to_commit(
    ws_id: str, graph_id: str, commit_id: str, body: RevertRequest,
    background: BackgroundTasks,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),   # writing main is privileged
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Reset main to its state at ``commit_id`` as ONE new ``restore`` commit
    (point-in-time rollback). Unlike revert, a restore overrides everything after
    the target by definition — no conflict path. Empty ``commitId`` no-op returns
    ``""``. Flag-gated like every versioning write (router-level gate)."""
    with _domain_errors():
        new_commit_id = await svc.restore_to_commit(
            graph_id=graph_id, commit_id=commit_id, actor=user.id, message=body.message,
        )
    await _bump_main_cache(graph_id)             # main advanced — invalidate stale canvas reads now
    await _touch_views_data_updated(graph_id, user.id)   # views' "data updated" freshness
    background.add_task(project_now, graph_id)   # refresh FalkorDB in-process after commit (async)
    return {"commit_id": new_commit_id}


@router.get("/graphs/{graph_id}/commits/{commit_id}/restore-preview",
            response_model=RestorePreviewResponse)
async def get_restore_preview(
    ws_id: str, graph_id: str, commit_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Exact impact a restore to ``commit_id`` would have (per-kind create/update/
    delete counts + how many commits roll back) — powers the confirm dialog.
    Same bounded compute as the write, nothing persisted."""
    with _domain_errors():
        return await svc.restore_preview(graph_id=graph_id, commit_id=commit_id)


# --------------------------------------------------------------------------- #
# Reads / audit                                                                #
# --------------------------------------------------------------------------- #
@router.get("/graphs/{graph_id}/branches/{branch_id}/state", response_model=StateResponse)
async def get_state(
    ws_id: str, graph_id: str, branch_id: str,
    as_of_seq: Optional[int] = Query(None, ge=0, alias="asOfSeq"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        state = await svc.materialize_state(graph_id=graph_id, branch_id=branch_id, as_of_seq=as_of_seq, viewer=viewer)
    wm = await svc.projection_watermark(graph_id)
    return {"nodes": state["nodes"], "edges": state["edges"],
            "watermark": {"committed": wm["committed"], "projected": wm["projected"], "fresh": wm["fresh"]}}


@router.get("/graphs/{graph_id}/commits/{commit_id}/state", response_model=StateResponse)
async def get_commit_state(
    ws_id: str, graph_id: str, commit_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Full graph state as of a specific commit (time-travel by commit id)."""
    with _domain_errors():
        state = await svc.state_at_commit(graph_id=graph_id, commit_id=commit_id, viewer=viewer)
    wm = await svc.projection_watermark(graph_id)
    return {"nodes": state["nodes"], "edges": state["edges"],
            "watermark": {"committed": wm["committed"], "projected": wm["projected"], "fresh": wm["fresh"]}}


@router.get("/graphs/{graph_id}/entities/{entity_id}/history", response_model=EntityHistoryResponse)
async def get_entity_history(
    ws_id: str, graph_id: str, entity_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    versions = await svc.entity_history(graph_id=graph_id, entity_id=entity_id, viewer=viewer)
    payload = {"entity_id": entity_id, "versions": versions}
    await _attach_user_names(session, versions, wrapper=payload)
    return payload


@router.get("/graphs/{graph_id}/commits", response_model=CommitLogResponse)
async def get_commit_log(
    ws_id: str, graph_id: str,
    branch_id: Optional[str] = Query(None, alias="branchId"),
    originating_view_id: Optional[str] = Query(None, alias="originatingViewId"),
    published_only: bool = Query(False, alias="publishedOnly"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Commit log for a branch (default ``main``), or — with ``originatingViewId`` — one
    view's history. ``publishedOnly=true`` returns the view's PUBLISHED (main) timeline
    (its squash-publishes + shared graph-level events), each drillable via the ``/squashed``
    endpoint; without it, every raw draft commit attributed to the view across branches."""
    with _domain_errors():
        commits = await svc.commit_log(
            graph_id=graph_id, branch_id=branch_id, originating_view_id=originating_view_id,
            published_only=published_only, limit=limit, offset=offset, viewer=viewer)
    payload = {"commits": commits}
    await _attach_user_names(session, commits, wrapper=payload)
    return payload


@router.get("/graphs/{graph_id}/commits/{commit_id}/squashed", response_model=CommitLogResponse)
async def get_squashed_commits(
    ws_id: str, graph_id: str, commit_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """The raw draft commits squashed into a publish/merge commit — the drill-down behind
    the "merged N commits" affordance. Empty for a non-squash commit."""
    with _domain_errors():
        commits = await svc.squashed_commits(
            graph_id=graph_id, commit_id=commit_id, limit=limit, offset=offset)
    payload = {"commits": commits}
    await _attach_user_names(session, commits, wrapper=payload)
    return payload


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff", response_model=DiffResponse)
async def get_diff(
    ws_id: str, graph_id: str, branch_id: str,
    from_seq: int = Query(..., ge=0, alias="fromSeq"),
    to_seq: int = Query(..., ge=0, alias="toSeq"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.diff_commits(graph_id=graph_id, branch_id=branch_id,
                                      from_seq=from_seq, to_seq=to_seq, viewer=viewer)


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff-window",
            response_model=DiffVsMainResponse)
async def get_diff_window(
    ws_id: str, graph_id: str, branch_id: str,
    from_seq: int = Query(..., ge=0, alias="fromSeq"),
    to_seq: int = Query(..., ge=0, alias="toSeq"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """A branch's changes between two seqs with WHOLE-PAYLOAD before/after — the shape the Changes
    panel renders. `/diff` answers the same question id-keyed, which can count the changes but not
    show them (no payloads ⇒ the UI can only print raw URNs). Used for "what came in when I pulled":
    the window is main between the draft's old and new base, and the pull commit records both seqs."""
    with _domain_errors():
        return await svc.diff_window(graph_id=graph_id, branch_id=branch_id,
                                     from_seq=from_seq, to_seq=to_seq, viewer=viewer)


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff-vs-main", response_model=DiffVsMainResponse)
async def get_diff_vs_main(
    ws_id: str, graph_id: str, branch_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Net diff of a draft against its base (``main`` at the branch point), returned
    as whole node/edge payloads with before/after — the shape the canvas diff overlay
    and Changes panel consume directly, without client-side state joins."""
    with _domain_errors():
        return await svc.diff_branch_vs_base(graph_id=graph_id, branch_id=branch_id, viewer=viewer)


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff-vs-main/summary",
            response_model=DiffSummaryResponse)
async def get_diff_vs_main_summary(
    ws_id: str, graph_id: str, branch_id: str,
    limit: int = Query(200, ge=1, le=1000),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Hierarchical (containment-tree) summary of a draft's changes for the canvas Changes
    panel — top-level groups + global counts + entityType impact rollup."""
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    with _domain_errors():
        return await svc.diff_branch_summary(
            graph_id=graph_id, branch_id=branch_id, containment_edge_types=cset, limit=limit, viewer=viewer)


@router.get("/graphs/{graph_id}/branches/{branch_id}/diff-vs-main/children",
            response_model=DiffChildrenResponse)
async def get_diff_vs_main_children(
    ws_id: str, graph_id: str, branch_id: str,
    container_key: str = Query(..., alias="containerKey"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """One group's direct children in a draft's hierarchical diff (lazy-load)."""
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    with _domain_errors():
        return await svc.diff_branch_children(
            graph_id=graph_id, branch_id=branch_id, container_key=container_key,
            containment_edge_types=cset, limit=limit, offset=offset, viewer=viewer)


@router.get("/graphs/{graph_id}/commits/{commit_id}/diff/summary",
            response_model=DiffSummaryResponse)
async def get_commit_diff_summary(
    ws_id: str, graph_id: str, commit_id: str,
    limit: int = Query(200, ge=1, le=1000),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Hierarchical summary of one commit's changes — the History tab's drill-down."""
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    with _domain_errors():
        return await svc.diff_commit_summary(
            graph_id=graph_id, commit_id=commit_id, containment_edge_types=cset, limit=limit, viewer=viewer)


@router.get("/graphs/{graph_id}/commits/{commit_id}/diff/children",
            response_model=DiffChildrenResponse)
async def get_commit_diff_children(
    ws_id: str, graph_id: str, commit_id: str,
    container_key: str = Query(..., alias="containerKey"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """One group's direct children in a commit's hierarchical diff (lazy-load)."""
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    with _domain_errors():
        return await svc.diff_commit_children(
            graph_id=graph_id, commit_id=commit_id, container_key=container_key,
            containment_edge_types=cset, limit=limit, offset=offset, viewer=viewer)


@router.get("/graphs/{graph_id}/graph/neighbors", response_model=GraphReadResponse)
async def graph_neighbors(
    ws_id: str, graph_id: str,
    urn: str = Query(..., description="seed node urn"),
    branch_id: Optional[str] = Query(None, alias="branchId"),
    as_of_seq: Optional[int] = Query(None, ge=0, alias="asOfSeq"),
    depth: int = Query(1, ge=1, le=20),
    direction: str = Query("both", pattern="^(out|in|both)$"),
    edge_types: Optional[str] = Query(None, alias="edgeTypes", description="comma-separated"),
    limit: int = Query(500, ge=1, le=5000),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    read_factory=Depends(get_falkor_read_factory),
):
    """Bounded neighborhood of a node — FalkorDB-first only for `main`@head (when the
    projection is caught up); drafts and as-of reads are served from Postgres. Every
    response carries the freshness watermark."""
    ets = [e for e in edge_types.split(",") if e] if edge_types else None
    return await _serve_neighbors(
        svc, read_factory, graph_id, urn=urn, depth=depth,
        direction=direction, edge_types=ets, limit=limit,
        branch_id=branch_id, as_of_seq=as_of_seq,
    )


async def _serve_neighbors(svc, read_factory, graph_id, *, urn, depth, direction,
                           edge_types, limit, branch_id=None, as_of_seq=None):
    wm = await svc.projection_watermark(graph_id)
    wm_out = {"committed": wm["committed"], "projected": wm["projected"], "fresh": wm["fresh"]}
    # FalkorDB projection is main@head only; drafts / as-of reads must use Postgres.
    is_head_main = as_of_seq is None and (
        branch_id is None or branch_id == await svc.main_branch_id(graph_id))
    can_falkor = bool(
        is_head_main and read_factory is not None and wm["status"] != "evicted" and wm["falkor_graph_name"]
        and wm["projected"] >= wm["committed"] - vconfig.READ_MAX_LAG
    )
    if can_falkor:
        await acquire_lease(graph_id)            # pin so an eviction sweep can't drop it mid-read
        try:
            # Factory contract is (name, provider_id=None); registry-backed factories
            # resolve the provider row asynchronously.
            graph = read_factory(wm["falkor_graph_name"], wm.get("falkor_provider"))
            if inspect.isawaitable(graph):
                graph = await graph
            result = await _falkor_neighbors(
                graph, urn=urn, depth=depth,
                direction=direction, edge_types=edge_types, limit=limit,
            )
            return {"source": "falkordb", "watermark": wm_out, **result}
        except Exception as exc:
            logger.warning("FalkorDB neighbors read failed for %s, PG fallback: %s", graph_id, exc)
        finally:
            await release_lease(graph_id)
    result = await svc.neighbors_from_state(
        graph_id=graph_id, urn=urn, branch_id=branch_id, as_of_seq=as_of_seq,
        depth=depth, direction=direction, edge_types=edge_types, limit=limit,
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
        # entityType lives on the FalkorDB LABEL, not as a property (the projector and
        # save_custom_graph both write it label-only). Recover it from the label exactly as
        # _extract_node_from_result does, else it collapses to "unknown" and the frontend can
        # neither resolve the type nor apply containment rules.
        labels = getattr(row[0], "labels", None) or []
        gn = _node_from_props(props, labels[0] if labels else None)
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


class SyncResponse(_ApiModel):
    commit_id: Optional[str] = None
    commit_seq: Optional[int] = None
    applied: int = 0
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


@router.post("/graphs/{graph_id}/sync", response_model=SyncResponse)
async def sync_ingest(
    ws_id: str, graph_id: str,
    request: Request,
    background: BackgroundTasks,
    idempotency_key: Optional[str] = Query(None, alias="idempotencyKey"),
    strategy: str = Query("merge", pattern="^(merge|external_wins)$"),
    source: str = Query("external"),
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Re-sync an authoritative external snapshot (ndjson, one node/edge per line) into
    ``main`` as a single ``sync`` commit via 3-way merge: user edits to untouched fields
    survive; a field both sides changed conflicts (409) under ``strategy=merge`` or takes
    the external value under ``strategy=external_wins``. A node the snapshot drops cascades
    to its containment subtree (ontology-driven). Idempotent on ``idempotencyKey``."""
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
    cset = await _live_containment_types(session, ws_id, _meta.get("data_source_id"))
    with _domain_errors():
        report = await svc.sync_ingest(
            graph_id=graph_id, rows=rows, actor=user.id, source=source,
            idempotency_key=idempotency_key, strategy=strategy, containment_edge_types=cset,
        )
    if report.get("commit_id"):
        background.add_task(nudge_projection, graph_id)
    return report


# --------------------------------------------------------------------------- #
# Bulk import / export (per data source / view) — plan Phases 1, 6, 7          #
# Backend-driven + automation-friendly: the same endpoints power the UI and a  #
# scripted client. Independent of the aggregation/ingestion worker.            #
# --------------------------------------------------------------------------- #
_ie_service = None


async def _resolve_export_view_scope(workspace_id, data_source_id, view_id, branch_id=None):
    """Resolve a view's ENTITY SET for a **view-scoped export**, from the authoritative source:
    the view's stored ``config`` reference-layout ``assignments`` map (canonical, up-converted from
    legacy per-layer ``entityAssignments`` by ``parse_reference_layout``) — the explicit
    physical-entity → logical-layer placements. A Context View places a top-level entity into a
    layer with ``inheritsChildren`` so the whole subtree belongs to the view — so the scope is the
    assigned URNs + their containment descendants (expanded in the worker, which has the graph).
    Returns a scope dict, or ``None`` (fail-open → whole data source) when the view has no explicit
    assignments (or is missing/malformed). Runs in the worker's background context, so it opens its
    own management-DB session."""
    if not (workspace_id and view_id):
        return None
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.models import ViewORM
        from backend.app.db.repositories.view_repo import effective_view_config
        from backend.app.services.layout_config import parse_reference_layout
        async with get_async_session() as session:
            view = await session.get(ViewORM, view_id)
            if view is None:
                return None
            # Branch-effective export scope: a draft export scopes to the draft's
            # own layer assignments (base ⊕ overlay); no branch/overlay → base.
            config = await effective_view_config(session, view, branch_id)
            cont = await _live_containment_types(session, workspace_id, data_source_id)
        layout = parse_reference_layout(config)
        # An assignment with a ``layerId`` is a real placement; ``logicalNodeId``-only ones are UI
        # pseudo-nodes, not graph entities (harmlessly skipped — they won't match a node urn).
        assigned = [u for u, a in layout.assignments.items() if a.get("layerId")]
        inherit = [u for u, a in layout.assignments.items() if a.get("inheritsChildren", True)]
        if not assigned:
            return None                              # nothing explicitly scoped → export whole DS
        return {"assigned_urns": assigned, "inherit_urns": inherit, "containment_types": cont}
    except Exception:
        logger.exception("view-scope resolution failed for export (view=%s)", view_id)
        return None


async def _resolve_ontology_types(workspace_id, data_source_id):
    """The CURRENT ontology's valid node + edge types for the **per-row import gate** — resolved
    live from the ontology service (management DB), never a stored snapshot. Returns
    ``{node_types, edge_types}`` or ``None`` (fail-open → gate skipped) when the ontology defines
    no types. Runs in the worker's background context, so it opens its own session."""
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService
        async with get_async_session() as session:
            resolved = await LocalOntologyService(SQLAlchemyOntologyRepository(session)).resolve(
                workspace_id=workspace_id, data_source_id=data_source_id)
        node_types = list(getattr(resolved, "entity_type_definitions", {}) or {})
        edge_types = list(getattr(resolved, "relationship_type_definitions", {}) or {})
        edge_types += list(getattr(resolved, "containment_edge_types", []) or [])
        edge_types += list(getattr(resolved, "lineage_edge_types", []) or [])
        if not node_types and not edge_types:
            return None
        return {"node_types": node_types, "edge_types": edge_types}
    except Exception:
        logger.exception("ontology type resolution failed for import (ds=%s)", data_source_id)
        return None


async def _write_view_import_assignments(ws, ds, view_id, created_nodes, batch_edges):
    """Layout-writer hook (injected into ImportExportService): after a view-scoped import creates new
    top-level entities, add canonical ``assignments`` entries (``assignedBy: 'import'``) to the view's
    stored reference-layout so a **curated** view renders them immediately — in the draft (its
    projection has the new entities) and after merge (they land on main). Reads the view's CURRENT
    config, merges ONLY the new roots (never overwriting an existing urn's entry, preserving every
    other config key), and writes via ``view_repo.update_view_layout`` in one update. Does NOT touch
    ``entityScope`` (sticky-scope) — harmless placement overrides on an 'all' view, the payoff on a
    'curated' one. Runs in the worker's background context, so it opens its own management-DB session.
    Returns ``{added: N}``; the service isolates any error onto the job summary."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM
    from backend.app.db.repositories import view_repo
    from backend.app.services.versioning.import_export.import_worker import (
        compute_import_root_assignments)
    from backend.common.models.management import ViewLayoutUpdateRequest

    async with get_async_session() as session:
        view = await session.get(ViewORM, view_id)
        if view is None:
            return {"added": 0}
        config = json.loads(view.config or "{}")
        raw = (config.get("layout") or {}).get("referenceLayout")
        if not isinstance(raw, dict):
            raw = config.get("referenceLayout")        # legacy top-level spelling
        if not isinstance(raw, dict) or not raw.get("layers"):
            return {"added": 0}                          # no layers → nowhere to place the roots
        existing = raw.get("assignments") if isinstance(raw.get("assignments"), dict) else {}
        cont = await _live_containment_types(session, ws, ds)
        new_entries = compute_import_root_assignments(
            created_nodes, batch_edges, cont, raw.get("layers"), existing)
        if not new_entries:
            return {"added": 0}
        merged = {**existing, **new_entries}
        # Rewrite the whole referenceLayout (update_view_layout replaces it wholesale) — preserve its
        # layers + every other key (displayRules, …), only extending the assignments map.
        new_ref = {**raw, "layers": raw.get("layers"), "assignments": merged}
        await view_repo.update_view_layout(
            session, view_id, ViewLayoutUpdateRequest(reference_layout=new_ref))
    return {"added": len(new_entries)}


def get_import_export_service():
    """Injectable Import/Export service (reuses the versioning singleton; overridable in tests)."""
    global _ie_service
    if _ie_service is None:
        from backend.app.services.versioning.import_export.service import ImportExportService
        _ie_service = ImportExportService(
            versioning=_service, scope_resolver=_resolve_export_view_scope,
            ontology_resolver=_resolve_ontology_types,
            layout_writer=_write_view_import_assignments)
    return _ie_service


class CreateImportResponse(_ApiModel):
    jobId: str
    branchId: str
    sourceUri: str
    status: str


@router.post("/graphs/{graph_id}/imports", response_model=CreateImportResponse, status_code=202)
async def create_import(
    ws_id: str, graph_id: str,
    request: Request,
    background: BackgroundTasks,
    format: str = Query("ndjson"),
    reconcile_mode: str = Query("upsert", alias="reconcileMode", pattern="^(upsert|replace)$"),
    branch_id: Optional[str] = Query(None, alias="branchId"),
    view_id: Optional[str] = Query(None, alias="viewId"),
    idempotency_key: Optional[str] = Query(None, alias="idempotencyKey"),
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    """Create a bulk import: open/append the user's working **draft**, stream the uploaded file to
    the object store, and dispatch the worker. The file is the raw request body (ndjson/csv/…);
    params are query args, so a client can drive the whole thing with one authenticated ``curl``.
    Review + publish/PR happen through the existing draft endpoints — this never writes to ``main``.
    ``branchId`` stacks onto an existing draft (repeat imports, like manual edits)."""
    from backend.app.services.versioning.import_export.formats import get_adapter
    try:
        get_adapter(format)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    with _domain_errors():
        created = await ie.create_import_job(
            workspace_id=ws_id, data_source_id=meta.get("data_source_id"), graph_id=graph_id,
            actor=user.id, import_format=format, provider_id=meta.get("provider_id"),
            branch_id=branch_id, reconcile_mode=reconcile_mode, scope_view_id=view_id,
            idempotency_key=idempotency_key)
    await ie.store.put_stream(created["source_uri"], request.stream())
    background.add_task(ie.run_import_safe, created["job_id"])
    return {"jobId": created["job_id"], "branchId": created["branch_id"],
            "sourceUri": created["source_uri"], "status": "running"}


@router.get("/graphs/{graph_id}/imports")
async def list_imports(
    ws_id: str, graph_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    """Import job history for this graph/data source (the per-view/data-source surface)."""
    return await ie.list_jobs(graph_id=graph_id, job_type="ingest")


# NOTE: declared before `/imports/{job_id}` so the literal path wins over the path param.
@router.get("/graphs/{graph_id}/imports/template")
async def import_template(
    ws_id: str, graph_id: str,
    format: str = Query("csv"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    """A prepopulated starter template (columns + a few real/example rows) so a user learns the
    import format instantly. Small + synchronous — returned as a direct file download."""
    from fastapi.responses import Response
    from backend.app.services.versioning.import_export.formats import get_adapter
    try:
        get_adapter(format)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    with _domain_errors():
        data = await ie.build_template(graph_id=graph_id, export_format=format)
    media = "text/csv" if format in ("csv", "tsv") else "application/x-ndjson"
    return Response(content=data, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="import-template.{format}"'})


@router.get("/graphs/{graph_id}/imports/{job_id}")
async def get_import(
    ws_id: str, graph_id: str, job_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    job = await ie.get_job(job_id)
    if job is None or job.get("graphId") != graph_id:
        raise HTTPException(status_code=404, detail="import job not found")
    return job


@router.get("/graphs/{graph_id}/imports/{job_id}/preview")
async def get_import_preview(
    ws_id: str, graph_id: str, job_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    """Summary counts + a bounded sample of resolved rows. The full field-level diff is the
    draft-vs-main diff served by the existing versioning endpoints."""
    preview = await ie.get_preview(job_id)
    if preview is None or preview["job"].get("graphId") != graph_id:
        raise HTTPException(status_code=404, detail="import job not found")
    return preview


class CreateExportResponse(_ApiModel):
    jobId: str
    resultUri: str
    status: str


@router.post("/graphs/{graph_id}/exports", response_model=CreateExportResponse, status_code=202,
             dependencies=[Depends(_GATE_GRAPH_EXPORT)])
async def create_export(
    ws_id: str, graph_id: str,
    background: BackgroundTasks,
    format: str = Query("ndjson"),
    as_of_seq: Optional[int] = Query(None, alias="asOfSeq"),
    view_id: Optional[str] = Query(None, alias="viewId"),
    branch_id: Optional[str] = Query(None, alias="branchId", description="Export this working branch's composed state (main + committed + draft); default = published main"),
    props: Optional[str] = Query(None, description="Comma-separated property names to add as empty columns to fill"),
    ids: Optional[str] = Query(None, description="Comma-separated entity_id/urn set — export only these entities"),
    types: Optional[str] = Query(None, description="Comma-separated entity types — export only these"),
    idempotency_key: Optional[str] = Query(None, alias="idempotencyKey"),
    user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    """Export the graph (or an as-of snapshot, E5) to a downloadable, re-importable artifact.
    A whole-data-source export doubles as a backup. Async: dispatches the worker, poll status."""
    from backend.app.services.versioning.import_export.formats import get_adapter
    try:
        get_adapter(format)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    _split = lambda v: [x.strip() for x in (v or "").split(",") if x.strip()]  # noqa: E731
    with _domain_errors():
        created = await ie.create_export_job(
            workspace_id=ws_id, data_source_id=meta.get("data_source_id"), graph_id=graph_id,
            actor=user.id, export_format=format, as_of_seq=as_of_seq, scope_view_id=view_id,
            branch_id=branch_id, provider_id=meta.get("provider_id"), extra_props=_split(props),
            select_ids=_split(ids), select_types=_split(types), idempotency_key=idempotency_key)
    background.add_task(ie.run_export_safe, created["job_id"])
    return {"jobId": created["job_id"], "resultUri": created["result_uri"], "status": "running"}


@router.get("/graphs/{graph_id}/exports")
async def list_exports(
    ws_id: str, graph_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    return await ie.list_jobs(graph_id=graph_id, job_type="export")


@router.get("/graphs/{graph_id}/exports/{job_id}")
async def get_export(
    ws_id: str, graph_id: str, job_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    job = await ie.get_job(job_id)
    if job is None or job.get("graphId") != graph_id:
        raise HTTPException(status_code=404, detail="export job not found")
    return job


@router.get("/graphs/{graph_id}/exports/{job_id}/download",
            dependencies=[Depends(_GATE_GRAPH_EXPORT)])
async def download_export(
    ws_id: str, graph_id: str, job_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    ie=Depends(get_import_export_service),
):
    from fastapi.responses import StreamingResponse
    result = await ie.open_result(job_id)
    if result is None or result[0].get("graphId") != graph_id:
        raise HTTPException(status_code=404, detail="export not found")
    job, stream = result
    if job.get("status") != "completed":
        raise HTTPException(status_code=409, detail={"type": "not_ready", "status": job.get("status")})
    fmt = job.get("importFormat") or "ndjson"
    return StreamingResponse(
        stream, media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="export-{job_id}.{fmt}"'})


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
    body: Optional[OpenPrRequest] = None,
    user: User = Depends(requires(_READ, workspace="ws_id")),       # read can propose
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        pr_id = await svc.open_pr(
            source_graph_id=graph_id, actor=user.id,
            title=body.title if body else None,
            description=body.description if body else None,
            reviewers=body.reviewers if body else None,
        )
    return {"pr_id": pr_id}


@router.get("/graphs/{graph_id}/pulls", response_model=List[PrResponse])
async def list_pull_requests(
    ws_id: str, graph_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    view_id: Optional[str] = Query(None, alias="viewId"),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """PRs targeting the graph — graph-wide (every view) by default; ``viewId`` narrows to
    PRs raised from that view's drafts (the Data-Source rollup stays the default, unfiltered)."""
    prs = await svc.list_pulls(
        target_graph_id=graph_id, limit=limit, offset=offset, viewer=viewer,
        originating_view_id=view_id)
    await _attach_user_names(session, prs)
    return prs


@router.get("/pulls/{pr_id}", response_model=PrResponse)
async def get_pull_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
    session: AsyncSession = Depends(get_db_session),
):
    await _attach_user_names(session, [pr])
    return pr


@router.patch("/pulls/{pr_id}", response_model=PrResponse)
async def update_pull_request(
    ws_id: str, pr_id: str, body: UpdatePrRequest,
    _user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Edit a PR's title/description (review metadata)."""
    with _domain_errors():
        return await svc.update_pr(pr_id=pr_id, title=body.title, description=body.description)


@router.get("/pulls/{pr_id}/preview", response_model=MergePreviewResponse)
async def preview_pull_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.preview_pr(pr_id=pr_id)


@router.get("/pulls/{pr_id}/diff", response_model=DiffVsMainResponse)
async def diff_pull_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Itemised Files Changed for a PR (same computation as ``/preview``, reshaped)."""
    with _domain_errors():
        return await svc.diff_pr(pr_id=pr_id)


@router.get("/pulls/{pr_id}/diff/summary", response_model=DiffSummaryResponse)
async def diff_pull_request_summary(
    ws_id: str, pr_id: str,
    limit: int = Query(200, ge=1, le=1000),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Hierarchical Files Changed for a PR (containment-tree summary)."""
    cset = await _pr_containment_types(svc, session, ws_id, pr)
    with _domain_errors():
        return await svc.diff_pr_summary(pr_id=pr_id, containment_edge_types=cset, limit=limit)


@router.get("/pulls/{pr_id}/diff/children", response_model=DiffChildrenResponse)
async def diff_pull_request_children(
    ws_id: str, pr_id: str,
    container_key: str = Query(..., alias="containerKey"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """One group's direct children in a PR's hierarchical diff (lazy-load)."""
    cset = await _pr_containment_types(svc, session, ws_id, pr)
    with _domain_errors():
        return await svc.diff_pr_children(
            pr_id=pr_id, container_key=container_key,
            containment_edge_types=cset, limit=limit, offset=offset)


@router.post("/pulls/{pr_id}/approve", response_model=PrResponse)
async def approve_pull_request(
    ws_id: str, pr_id: str,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),     # a manager approves
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.approve_pr(pr_id=pr_id, actor=user.id)


@router.post("/pulls/{pr_id}/close", response_model=PrResponse)
async def close_pull_request(
    ws_id: str, pr_id: str,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),     # a manager rejects/closes
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.close_pr(pr_id=pr_id, actor=user.id)


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
    await _bump_main_cache(str(_pr["target_graph_id"]))            # base advanced — invalidate stale canvas reads now
    await _touch_views_data_updated(str(_pr["target_graph_id"]), user.id)   # views' "data updated" freshness
    background.add_task(project_now, str(_pr["target_graph_id"]))   # base graph advanced; refresh FalkorDB in-process (async)
    return {"commit_id": commit_id}


# --------------------------------------------------------------------------- #
# Draft -> main merge requests (reviewed publish)                              #
# --------------------------------------------------------------------------- #
@router.post("/graphs/{graph_id}/branches/{branch_id}/merge-requests",
             response_model=OpenPrResponse, status_code=201)
async def open_merge_request(
    ws_id: str, graph_id: str, branch_id: str,
    body: Optional[OpenMrRequest] = None,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),     # the draft owner raises the MR
    _meta: dict = Depends(graph_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Raise a formal merge request from a per-user draft to its graph's ``main``."""
    with _domain_errors():
        pr_id = await svc.open_draft_mr(
            graph_id=graph_id, branch_id=branch_id, actor=user.id,
            title=body.title if body else None,
            description=body.description if body else None,
            reviewers=body.reviewers if body else None,
        )
    return {"pr_id": pr_id}


@router.get("/graphs/{graph_id}/merge-requests", response_model=List[PrResponse])
async def list_merge_requests(
    ws_id: str, graph_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _meta: dict = Depends(graph_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """All merge requests targeting this graph's ``main`` (draft MRs + incoming fork PRs)."""
    prs = await svc.list_pulls(target_graph_id=graph_id, limit=limit, offset=offset, viewer=viewer)
    await _attach_user_names(session, prs)
    return prs


# --------------------------------------------------------------------------- #
# View- and data-source-scoped PR access (the canvas review layer)             #
# --------------------------------------------------------------------------- #
@router.get("/views/{view_id}/pull-requests", response_model=List[PrResponse])
async def list_view_pull_requests(
    ws_id: str, view_id: str,
    pr_status: Optional[str] = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _view: dict = Depends(view_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """PRs raised from this view (matched via the source branch's ``originating_view_id``)."""
    prs = await svc.list_pulls(
        originating_view_id=view_id, status=pr_status, limit=limit, offset=offset, viewer=viewer)
    await _attach_user_names(session, prs)
    return prs


@router.get("/views/{view_id}/pull-requests/count", response_model=ViewPrCountResponse)
async def count_view_pull_requests(
    ws_id: str, view_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    view: dict = Depends(view_in_workspace),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Active-PR counts for the view's indicator: ``fromView`` (raised from this view) and
    ``onDataSource`` (against the view's whole data source) — both excluding merged/closed."""
    from_view = await svc.count_pulls(originating_view_id=view_id, active_only=True, viewer=viewer)
    on_ds = 0
    ds = view.get("data_source_id")
    if ds:
        on_ds = await svc.count_pulls(data_source_id=ds, active_only=True, viewer=viewer)
    return {"fromView": from_view, "onDataSource": on_ds}


@router.get("/data-sources/{data_source_id}/pull-requests", response_model=List[PrResponse])
async def list_data_source_pull_requests(
    ws_id: str, data_source_id: str,
    pr_status: Optional[str] = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    viewer: Viewer = Depends(viewer_ctx),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """All PRs against a data source (every view on it). Tenant-isolated: the data source's
    graph must live in ``ws_id``."""
    g = await svc.get_graph_by_data_source(data_source_id)
    if g is None or g["workspace_id"] != ws_id:
        raise HTTPException(status_code=404, detail="data source not found in workspace")
    prs = await svc.list_pulls(
        data_source_id=data_source_id, status=pr_status, limit=limit, offset=offset, viewer=viewer)
    await _attach_user_names(session, prs)
    return prs


@router.get("/merge-requests/{pr_id}", response_model=PrResponse)
async def get_merge_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
    session: AsyncSession = Depends(get_db_session),
):
    await _attach_user_names(session, [pr])
    return pr


@router.patch("/merge-requests/{pr_id}", response_model=PrResponse)
async def update_merge_request(
    ws_id: str, pr_id: str, body: UpdatePrRequest,
    _user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Edit a merge request's title/description (review metadata)."""
    with _domain_errors():
        return await svc.update_pr(pr_id=pr_id, title=body.title, description=body.description)


@router.get("/merge-requests/{pr_id}/preview", response_model=MergePreviewResponse)
async def preview_merge_request_endpoint(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.preview_mr(mr_id=pr_id)


@router.get("/merge-requests/{pr_id}/diff", response_model=DiffVsMainResponse)
async def diff_merge_request(
    ws_id: str, pr_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Itemised Files Changed for a merge request (same computation as ``/preview``)."""
    with _domain_errors():
        return await svc.diff_pr(pr_id=pr_id)


@router.get("/merge-requests/{pr_id}/diff/summary", response_model=DiffSummaryResponse)
async def diff_merge_request_summary(
    ws_id: str, pr_id: str,
    limit: int = Query(200, ge=1, le=1000),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Hierarchical Files Changed for a merge request — containment-tree summary (top-level
    groups + global counts + entityType impact). Children load via ``/diff/children``."""
    cset = await _pr_containment_types(svc, session, ws_id, pr)
    with _domain_errors():
        return await svc.diff_pr_summary(pr_id=pr_id, containment_edge_types=cset, limit=limit)


@router.get("/merge-requests/{pr_id}/diff/children", response_model=DiffChildrenResponse)
async def diff_merge_request_children(
    ws_id: str, pr_id: str,
    container_key: str = Query(..., alias="containerKey"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """One group's direct children in a merge request's hierarchical diff (lazy-load)."""
    cset = await _pr_containment_types(svc, session, ws_id, pr)
    with _domain_errors():
        return await svc.diff_pr_children(
            pr_id=pr_id, container_key=container_key,
            containment_edge_types=cset, limit=limit, offset=offset)


@router.post("/merge-requests/{pr_id}/approve", response_model=PrResponse)
async def approve_merge_request(
    ws_id: str, pr_id: str,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.approve_pr(pr_id=pr_id, actor=user.id)


@router.post("/merge-requests/{pr_id}/close", response_model=PrResponse)
async def close_merge_request(
    ws_id: str, pr_id: str,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    with _domain_errors():
        return await svc.close_pr(pr_id=pr_id, actor=user.id)


@router.post("/merge-requests/{pr_id}/merge", response_model=CommitResponse)
async def merge_merge_request(
    ws_id: str, pr_id: str, body: MergePrRequest,
    background: BackgroundTasks,
    user: User = Depends(requires(_MANAGE, workspace="ws_id")),
    _pr: dict = Depends(pr_in_workspace),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    cset = await _pr_containment_types(svc, session, ws_id, _pr)
    rules = await _pr_ontology_rules(svc, session, ws_id, _pr)
    with _domain_errors():
        commit_id = await svc.merge_mr(
            mr_id=pr_id, actor=user.id, message=body.message, resolutions=body.resolutions,
            containment_edge_types=cset, ontology_rules=rules,
        )
    await _bump_main_cache(str(_pr["target_graph_id"]))            # target advanced — invalidate stale canvas reads now
    await _touch_views_data_updated(str(_pr["target_graph_id"]), user.id)   # views' "data updated" freshness
    _src_branch = _pr.get("source_branch_id")   # the merged draft — fold its layout overlay into the published view
    await _promote_view_layout_overlay(str(_src_branch) if _src_branch else None, user.id)
    background.add_task(project_now, str(_pr["target_graph_id"]))   # target graph advanced; refresh FalkorDB in-process (async)
    return {"commit_id": commit_id}
