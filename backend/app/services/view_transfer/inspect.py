"""Inspect an uploaded view file: is it sound, is it already here, and where does it belong?

Three answers, before anything is written:

* integrity: each view re-hashed against the hash the exporter recorded (``bundle``);
* identity: live views here that carry the same ``portable_id``, meaning they are this view
  (imported before, or where it was born), with how the two sides stand (``merge``);
* targets: this environment's data sources ranked against the file's description of where
  each view came from, then probed with a sample of the view's own entities, so "this is the
  one" is measured, not guessed.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import rbac_flag
from backend.app.db.models import (
    CatalogItemORM,
    OntologyORM,
    ProviderORM,
    ViewORM,
    ViewVersionORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    view_is_live,
)
from backend.app.db.repositories import view_version_repo
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.view_transfer.bundle import ParsedBundle
from backend.app.services.view_transfer.merge import update_status
from backend.app.services.view_transfer.references import URN_KIND_ASSIGNMENT, collect, urns_of_kind
from backend.app.services.view_transfer.sources import effective_data_source, engine_for

logger = logging.getLogger(__name__)

#: Entities probed per candidate data source.
SAMPLE_SIZE = 50
#: Candidates probed per source (the top by description score).
PROBED_CANDIDATES = 3


def _norm(value: Optional[str]) -> str:
    return (value or "").strip().casefold()


async def target_versions(session: AsyncSession, view_id: str) -> List[tuple]:
    """``(version, hash, origin_hash)`` for every version of a view: all a merge base needs."""
    result = await session.execute(
        select(ViewVersionORM.version, ViewVersionORM.content_hash, ViewVersionORM.origin_hash)
        .where(ViewVersionORM.view_id == view_id)
    )
    return [tuple(row) for row in result.all()]


async def identity_matches(
    session: AsyncSession, parsed: ParsedBundle, ctx: Optional[view_access.ViewerContext],
) -> Dict[str, List[Dict[str, Any]]]:
    """Live views here that ARE a view in the file, with how each stands against it."""
    by_portable = {v.portable_id: v for v in parsed.views}
    if not by_portable:
        return {}
    rows = (await session.execute(
        select(ViewORM).where(ViewORM.portable_id.in_(list(by_portable)), view_is_live())
    )).scalars().all()
    enforce = rbac_flag("RBAC_ENFORCE_VIEWS") and ctx is not None
    out: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        if enforce and not await view_access.can_read_view(session, ctx, row):
            continue
        view = by_portable[row.portable_id]
        latest = await view_version_repo.head(session, row.id)
        working = await view_version_repo.working_state_async(row)
        history = [h.get("hash") for h in view.raw.get("history") or [] if isinstance(h, dict)]
        state = update_status(
            incoming_hash=view.actual_hash, incoming_history_hashes=history,
            target_working_hash=working.content_hash,
            target_versions=await target_versions(session, row.id),
        )
        workspace = await session.get(WorkspaceORM, row.workspace_id)
        ds = await effective_data_source(session, row)
        out.setdefault(row.portable_id, []).append({
            "viewId": row.id,
            "name": row.name,
            "workspaceId": row.workspace_id,
            "workspaceName": workspace.name if workspace else None,
            "dataSourceId": ds.id if ds else None,
            "dataSourceName": ds.label if ds else None,
            "headVersion": latest.version if latest else None,
            "canEdit": (not enforce) or await view_access.can_edit_view(session, ctx, row),
            "status": state.status,
            "baseVersion": state.base_version,
        })
    return out


async def _candidates(session: AsyncSession, claims: Optional[PermissionClaims]) -> List[WorkspaceDataSourceORM]:
    """Live, active data sources in live workspaces where the caller may create views."""
    rows = (await session.execute(
        select(WorkspaceDataSourceORM).where(
            WorkspaceDataSourceORM.deleted_at.is_(None), WorkspaceDataSourceORM.is_active.is_(True),
        )
    )).scalars().all()
    out = []
    live_ws: Dict[str, bool] = {}
    for ds in rows:
        if ds.workspace_id not in live_ws:
            ws = await session.get(WorkspaceORM, ds.workspace_id)
            live_ws[ds.workspace_id] = bool(ws and ws.deleted_at is None and ws.is_active)
        if not live_ws[ds.workspace_id]:
            continue
        if rbac_flag("RBAC_ENFORCE_VIEWS") and claims is not None and not has_permission(
                claims, "workspace:view:create", workspace_id=ds.workspace_id):
            continue
        out.append(ds)
    return out


async def _score(session: AsyncSession, ds: WorkspaceDataSourceORM, source: Dict[str, Any],
                 cache: Dict[str, Any]) -> tuple:
    """How closely a data source here matches the file's description of a source, and why."""
    described = source.get("dataSource") or {}
    ontology = source.get("ontology") or {}

    async def _get(model, key):
        if not key:
            return None
        cache_key = f"{model.__name__}:{key}"
        if cache_key not in cache:
            cache[cache_key] = await session.get(model, key)
        return cache[cache_key]

    provider = await _get(ProviderORM, ds.provider_id)
    catalog = await _get(CatalogItemORM, ds.catalog_item_id)
    onto = await _get(OntologyORM, ds.ontology_id)
    score, reasons = 0, []
    if described.get("providerType") and provider and _norm(provider.provider_type) == _norm(described["providerType"]):
        score += 30
        reasons.append("Same kind of graph database")
    graph_names = {_norm(ds.graph_name), _norm(catalog.source_identifier if catalog else None)} - {""}
    wanted = {_norm(described.get("graphName")), _norm(described.get("catalogSourceIdentifier"))} - {""}
    if graph_names & wanted:
        score += 40
        reasons.append("Same graph")
    if ontology.get("name") and onto and _norm(onto.name) == _norm(ontology["name"]):
        score += 15
        reasons.append("Same semantic layer")
    if described.get("label") and _norm(ds.label) == _norm(described["label"]):
        score += 5
        reasons.append("Same name")
    return score, reasons


async def target_suggestions(
    session: AsyncSession, parsed: ParsedBundle, claims: Optional[PermissionClaims],
) -> Dict[str, List[Dict[str, Any]]]:
    """Per source in the file, the best-matching data sources here, best first."""
    candidates = await _candidates(session, claims)
    cache: Dict[str, Any] = {}
    out: Dict[str, List[Dict[str, Any]]] = {}
    for key, source in parsed.bundle.sources.items():
        described = source.model_dump(mode="json")
        scored = []
        for ds in candidates:
            score, reasons = await _score(session, ds, described, cache)
            if score > 0:
                scored.append((score, reasons, ds))
        scored.sort(key=lambda s: (-s[0], s[2].label or ""))
        sample = sorted({
            urn for view in parsed.views if view.source_key == key
            for urn in urns_of_kind(collect(view.definition), URN_KIND_ASSIGNMENT)
        })[:SAMPLE_SIZE]
        digest = (described.get("ontology") or {}).get("digest")
        rows = []
        for rank, (score, reasons, ds) in enumerate(scored[:10]):
            hit_rate = None
            if rank < PROBED_CANDIDATES and (sample or digest):
                try:
                    engine = await engine_for(session, ds.workspace_id, ds.id)
                    # The same ontology, to the byte (both sides digest it alike): every type the
                    # file names means here what it meant there.
                    if digest and await engine.get_ontology_digest() == digest:
                        score, reasons = score + 10, [*reasons, "Identical semantic layer"]
                    if sample:
                        found = await engine.provider.resolve_identities(sample)
                        checked = len(found)
                        hit_rate = (sum(1 for v in found.values() if v) / checked) if checked else None
                except Exception as exc:  # noqa: BLE001 — a probe that can't run is just unknown
                    logger.info("inspect: probe of %s failed: %s", ds.id, exc)
            workspace = cache.get(f"ws:{ds.workspace_id}") or await session.get(WorkspaceORM, ds.workspace_id)
            cache[f"ws:{ds.workspace_id}"] = workspace
            provider = cache.get(f"ProviderORM:{ds.provider_id}")
            rows.append({
                "workspaceId": ds.workspace_id,
                "workspaceName": workspace.name if workspace else None,
                "dataSourceId": ds.id,
                "label": ds.label,
                "providerType": provider.provider_type if provider else None,
                "graphName": ds.graph_name,
                "score": score,
                "reasons": reasons,
                "sampleSize": len(sample),
                "sampleHitRate": hit_rate,
            })
        rows.sort(key=lambda r: (-(r["sampleHitRate"] if r["sampleHitRate"] is not None else -1), -r["score"]))
        out[key] = rows[:5]
    return out


def view_payload(parsed: ParsedBundle) -> List[Dict[str, Any]]:
    """The views as the wizard needs them: canonical definitions plus each one's integrity."""
    out = []
    for view in parsed.views:
        raw = view.raw
        out.append({
            "index": view.index,
            "source": view.source_key,
            "portableId": view.portable_id,
            "sourceViewId": raw.get("sourceViewId"),
            "version": raw.get("version"),
            "definitionHash": view.claimed_hash,
            "actualHash": view.actual_hash,
            "integrity": view.integrity,
            "metadata": raw.get("metadata"),
            "definition": view.definition,
            "manifest": raw.get("manifest") or {},
            "history": raw.get("history") or [],
            "historyTruncated": bool(raw.get("historyTruncated")),
        })
    return out
