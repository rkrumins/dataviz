"""Reconcile and import: check views from a file against this environment, then write them.

``reconcile_items`` is the wizard's preview. For each view it works out the definition that
would be written (the file's, merged with the view here when updating, with the person's
choices applied) and reconciles it against the target graph. Views that share a target data
source share one identity lookup.

``import_item`` writes one view, in the caller's transaction: create or update the row,
record an ``import`` version whose provenance keeps where it came from and how well it
matched, record activity, and re-read the result so the response can PROVE what was stored.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import view_activity_repo, view_repo, view_version_repo
from backend.app.services.layout_config import sanitize_node_ordering
from backend.app.services.view_transfer.canonical import (
    config_from_definition, content_hash, portable_definition,
)
from backend.app.services.view_transfer.diff import diff_definitions
from backend.app.services.view_transfer.inspect import target_versions
from backend.app.services.view_transfer.merge import DIVERGED, merge_definitions, update_status
from backend.app.services.view_transfer.reconcile import Policy, TargetTypes, aggregate, reconcile_view
from backend.app.services.view_transfer.references import Rewrite, collect, reference_layout, rewrite
from backend.app.services.view_transfer.sources import engine_for
from backend.common.models.management import ViewCreateRequest

logger = logging.getLogger(__name__)


@dataclass
class Target:
    workspace_id: str
    data_source_id: Optional[str]
    view: Optional[ViewORM] = None       # set when updating / overwriting


@dataclass
class ReconcileItem:
    key: str
    definition: Dict[str, Any]
    view_type: str
    exported: Dict[str, Dict[str, Any]]
    entities_resolved: bool
    history_hashes: List[str]
    action: str                          # create | copy | update | overwrite
    strategy: str                        # replace | merge
    rewrite: Rewrite
    target: Target


@dataclass
class Prepared:
    item: ReconcileItem
    effective: dict
    update: Optional[Dict[str, Any]] = None
    conflicts: List[str] = field(default_factory=list)


async def _policy(session: AsyncSession, view_type: str) -> Policy:
    from backend.app.api.v1.feature_gate import ensure_view_mode_allowed
    from backend.app.services.feature_flags import feature_flags

    allowed = True
    try:
        await ensure_view_mode_allowed(view_type, session)
    except HTTPException:
        allowed = False
    sorting = await feature_flags.is_enabled("nodeSortingEnabled", session, default=True)
    return Policy(view_type_allowed=allowed, node_sorting_enabled=sorting)


async def _prepare(session: AsyncSession, item: ReconcileItem) -> Prepared:
    """The definition this item would write, and (when updating) how it stands."""
    incoming = portable_definition(item.definition, item.view_type)
    incoming_hash = content_hash(incoming)
    effective = incoming
    update: Optional[Dict[str, Any]] = None
    conflicts: List[str] = []
    row = item.target.view
    working = view_version_repo.working_state(row) if row is not None else None
    if row is not None:
        versions = await target_versions(session, row.id)
        state = update_status(
            incoming_hash=incoming_hash, incoming_history_hashes=item.history_hashes,
            target_working_hash=working.content_hash, target_versions=versions,
        )
        mergeable = state.status == DIVERGED and item.action == "update"
        if item.strategy == "merge" and mergeable:
            base_row = await view_version_repo.get_version(session, row.id, state.base_version)
            base = view_version_repo.base_definition(base_row, state.base_hash)
            merged = merge_definitions(base, working.definition, incoming)
            effective, conflicts = portable_definition(merged.definition, item.view_type), merged.conflicts
        latest = await view_version_repo.head(session, row.id)
        update = {
            "status": state.status,
            "base": {"version": state.base_version, "hash": state.base_hash} if state.base_version else None,
            "targetHead": {"version": latest.version, "hash": latest.content_hash} if latest else None,
            "targetWorkingHash": working.content_hash,
            "mergeAvailable": mergeable,
            "strategy": item.strategy if mergeable else "replace",
            "conflicts": conflicts,
        }
    if not item.rewrite.is_empty():
        effective = portable_definition(rewrite(effective, item.rewrite), item.view_type)
    if update is not None and working is not None:
        update["diff"] = diff_definitions(working.definition, effective, sample_limit=50)
    return Prepared(item=item, effective=effective, update=update, conflicts=conflicts)


async def _target_facts(session: AsyncSession, target: Target, urns: List[str]):
    """One identity lookup and one ontology read for a target data source."""
    lookup: Dict[str, Optional[dict]] = {}
    types = TargetTypes()
    try:
        engine = await engine_for(session, target.workspace_id, target.data_source_id)
    except Exception as exc:  # noqa: BLE001 — every entity becomes "unknown", never "missing"
        logger.warning("reconcile: target %s/%s unreachable: %s",
                       target.workspace_id, target.data_source_id, exc)
        return lookup, types
    if urns:
        try:
            lookup = await engine.provider.resolve_identities(urns)
        except Exception as exc:  # noqa: BLE001
            logger.warning("reconcile: identity lookup failed: %s", exc)
    try:
        resolved = await engine.get_resolved_ontology()
        types = TargetTypes(
            entity={tid: getattr(d, "name", "") or tid
                    for tid, d in (resolved.entity_type_definitions or {}).items()},
            relationship={
                **{tid: getattr(d, "name", "") or tid
                   for tid, d in (resolved.relationship_type_definitions or {}).items()},
                **{t: t for t in (resolved.containment_edge_types or [])},
                **{t: t for t in (resolved.lineage_edge_types or [])},
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("reconcile: ontology unavailable: %s", exc)
    return lookup, types


async def reconcile_items(session: AsyncSession, items: List[ReconcileItem]) -> Dict[str, Any]:
    prepared = [await _prepare(session, item) for item in items]

    groups: Dict[Tuple[str, Optional[str]], List[Prepared]] = {}
    for p in prepared:
        groups.setdefault((p.item.target.workspace_id, p.item.target.data_source_id), []).append(p)
    facts: Dict[Tuple[str, Optional[str]], tuple] = {}
    for key, members in groups.items():
        urns = sorted({u for m in members for u in collect(m.effective).urns})
        facts[key] = await _target_facts(session, members[0].item.target, urns)

    results = []
    reports = []
    for p in prepared:
        lookup, types = facts[(p.item.target.workspace_id, p.item.target.data_source_id)]
        report = reconcile_view(
            p.effective, exported=p.item.exported, lookup=lookup, types=types,
            policy=await _policy(session, p.item.view_type),
            entities_resolved_at_export=p.item.entities_resolved,
        )
        reports.append(report)
        results.append({
            "key": p.item.key,
            "effectiveDefinition": p.effective,
            "effectiveHash": content_hash(p.effective),
            "report": report,
            "update": p.update,
        })
    return {"views": results, "aggregate": aggregate(reports)}


# ── Import ──────────────────────────────────────────────────────────────────


@dataclass
class ImportItem:
    action: str                           # create | copy | update | overwrite
    target: Target
    metadata: Dict[str, Any]              # name, description, icon, tags, viewType, visibility
    definition: Dict[str, Any]
    provenance: Dict[str, Any]            # from the file: portableId, sourceViewId, version, ...
    history: List[Dict[str, Any]]
    exported: Dict[str, Dict[str, Any]]
    entities_resolved: bool
    resolutions_summary: Dict[str, Any]
    expected_target_hash: Optional[str]
    request_id: Optional[str]
    batch_id: Optional[str]
    strategy: str = "replace"
    #: The file's own definition, when what is written differs from it (see ``origin_hash``).
    origin_definition: Optional[Dict[str, Any]] = None


class AlreadyImported(Exception):
    """Another attempt of the same request (same ``request_id``) finished first. The caller
    rolls this attempt back and answers with that one's result (``replay``)."""


async def _portable_id_taken(session: AsyncSession, workspace_id: str, portable_id: str) -> bool:
    found = await session.execute(
        select(ViewORM.id).where(ViewORM.workspace_id == workspace_id,
                                 ViewORM.portable_id == portable_id,
                                 ViewORM.deleted_at.is_(None)).limit(1))
    return found.first() is not None


def _pct(rate: Optional[float]) -> str:
    return "n/a" if rate is None else f"{rate * 100:.1f}%"


async def import_item(
    session: AsyncSession,
    item: ImportItem,
    *,
    actor: Optional[str],
    ontology_digest: Optional[str],
) -> Dict[str, Any]:
    """Write one imported view and its ``import`` version, in the caller's transaction.

    Raises ``HTTPException`` (409) when an update target changed since it was reviewed, and
    :class:`AlreadyImported` when a concurrent attempt of the same request got there first.
    """
    view_type = item.metadata.get("viewType") or "graph"
    definition = portable_definition(item.definition, view_type)
    submitted_hash = content_hash(definition)
    origin_definition = (portable_definition(item.origin_definition, view_type)
                         if item.origin_definition is not None else None)

    # The same write-side rules every layout write obeys.
    adjustments: List[str] = []
    rl = reference_layout(definition)
    if rl is not None:
        view_repo._validate_layer_refs({"layers": rl.get("layers") or [],
                                        "assignments": rl.get("assignments") or {}})
        sanitized = await view_repo._gate_node_ordering(session, sanitize_node_ordering(rl))
        if sanitized != rl:
            adjustments.append("Custom node order was dropped: node sorting is turned off here.")
            definition["layout"]["referenceLayout"] = sanitized

    notices: List[str] = []
    incoming_portable = item.provenance.get("portableId")
    if item.action in ("create", "copy"):
        portable_id = incoming_portable
        forked_from = None
        if item.action == "copy" or not portable_id or await _portable_id_taken(
                session, item.target.workspace_id, portable_id):
            if item.action == "create" and portable_id:
                notices.append("A view with this identity already exists in this workspace, so this "
                               "one was imported as a separate copy.")
            forked_from = portable_id
            portable_id = f"pv_{uuid.uuid4().hex}"
        created = await view_repo.create_view(
            session,
            ViewCreateRequest(
                name=item.metadata["name"],
                description=item.metadata.get("description"),
                workspaceId=item.target.workspace_id,
                dataSourceId=item.target.data_source_id,
                viewType=view_type,
                config=config_from_definition(definition, icon=item.metadata.get("icon")),
                visibility=item.metadata.get("visibility") or "private",
                tags=item.metadata.get("tags") or None,
            ),
            ontology_digest=ontology_digest, user_id=actor,
        )
        row = (await session.execute(select(ViewORM).where(ViewORM.id == created.id))).scalar_one()
        row.portable_id = portable_id
        if forked_from:
            item.provenance = {**item.provenance, "forkedFrom": forked_from}
    else:
        row = item.target.view
        assert row is not None
        await session.refresh(row, with_for_update=True)
        if item.expected_target_hash and view_version_repo.working_state(row).content_hash != item.expected_target_hash:
            raise HTTPException(status_code=409, detail={
                "type": "target_changed",
                "message": f"'{row.name}' changed after you reviewed it. Check it again before importing.",
            })
        # Nothing here is lost to an import: the view's current design is a version before the
        # file replaces it, even when it only existed as unsaved canvas edits.
        latest = await view_version_repo.ensure_baseline(session, row)
        if view_version_repo.status(row, latest)["dirty"]:
            await view_version_repo.checkpoint(
                session, row, source="snapshot", actor=actor,
                message="Saved automatically before importing",
            )
        row.config = json.dumps(config_from_definition(definition, icon=item.metadata.get("icon")))
        row.name = item.metadata["name"]
        row.description = item.metadata.get("description")
        row.tags = json.dumps(item.metadata["tags"]) if item.metadata.get("tags") else None
        row.view_type = view_type
        if item.action == "overwrite" and incoming_portable:
            # The view here now tracks the file's view: its next export and import line up.
            row.portable_id = incoming_portable
        if ontology_digest is not None:
            row.ontology_digest = ontology_digest
        if actor is not None:
            row.updated_by = actor
    await session.flush()

    # The authoritative record of how well it matched, taken on what is actually stored.
    stored = view_version_repo.working_state(row)
    lookup, types = await _target_facts(session, Target(row.workspace_id, item.target.data_source_id),
                                        sorted(collect(stored.definition).urns))
    report = reconcile_view(stored.definition, exported=item.exported, lookup=lookup, types=types,
                            policy=await _policy(session, view_type),
                            entities_resolved_at_export=item.entities_resolved)
    summary = report["summary"]
    origin = {
        "environment": item.provenance.get("environment"),
        "viewId": item.provenance.get("sourceViewId"),
        "version": item.provenance.get("version"),
        "hash": item.provenance.get("definitionHash"),
        "portableId": incoming_portable,
        "exportedAt": item.provenance.get("exportedAt"),
        "exportedBy": item.provenance.get("exportedBy"),
        "fileName": item.provenance.get("fileName"),
    }
    # What was stored differs from the file: keep the file's design, so a later file from the
    # same lineage can still merge from it (``view_version_repo.base_definition``).
    origin_hash = content_hash(origin_definition) if origin_definition is not None else None
    diverges = origin_hash is not None and origin_hash != stored.content_hash
    provenance = {
        "origin": origin,
        "ancestry": item.history,
        "action": item.action,
        "strategy": item.strategy,
        "batchId": item.batch_id,
        "forkedFrom": item.provenance.get("forkedFrom"),
        "resolutions": item.resolutions_summary,
        "adjustments": adjustments,
        "report": {"summary": summary, "layers": report["layers"]},
    }
    if diverges:
        provenance["originDefinition"] = origin_definition
    version, created = await view_version_repo.checkpoint(
        session, row, source="import", actor=actor, force=True,
        origin_hash=origin_hash if diverges else None,
        message=f"Imported from {origin['environment'] or 'another environment'}"
                + (f" (v{origin['version']})" if origin.get("version") else ""),
        provenance=provenance, request_id=item.request_id,
    )
    if not created:  # a forced checkpoint only declines when its request id is already taken
        raise AlreadyImported()
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="imported", actor=actor,
        summary=(f"Imported from {origin['environment'] or 'another environment'}"
                 f" · {item.provenance.get('name') or row.name}"
                 + (f" v{origin['version']}" if origin.get("version") else "")
                 + f" · {_pct(summary['matchRate'])} matched"),
        changes={"action": item.action, "version": version.version, "batchId": item.batch_id},
    )
    return {
        "viewId": row.id,
        "version": view_version_repo.to_summary(version),
        "report": report,
        "notices": notices,
        "integrity": {
            "submittedHash": submitted_hash,
            "storedHash": stored.content_hash,
            "verified": stored.content_hash == submitted_hash,
            "adjusted": bool(adjustments),
            "adjustments": adjustments,
        },
    }


async def replay(session: AsyncSession, request_id: str, actor: Optional[str]) -> Optional[Dict[str, Any]]:
    """The result a previous attempt of this request already wrote, if any.

    Raises ``HTTPException`` (409) when the id belongs to someone else's import: request ids
    are made by the client, and one person's retry must never answer with another's view.
    """
    version = await view_version_repo.find_by_request_id(session, request_id)
    if version is None:
        return None
    if version.source != "import" or version.created_by != actor:
        raise HTTPException(status_code=409, detail={
            "type": "request_id_taken", "message": "This request id was already used. Try again.",
        })
    summary = view_version_repo.to_summary(version)
    report = ((summary.get("provenance") or {}).get("report")) or {}
    return {"viewId": version.view_id, "version": summary, "report": report, "notices": [],
            "integrity": {"submittedHash": version.content_hash, "storedHash": version.content_hash,
                          "verified": True, "adjusted": False, "adjustments": [], "replayed": True}}


__all__ = ["AlreadyImported", "Target", "ReconcileItem", "ImportItem", "reconcile_items",
           "import_item", "replay"]
