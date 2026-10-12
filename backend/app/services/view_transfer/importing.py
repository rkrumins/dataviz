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

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import view_activity_repo, view_repo, view_version_repo
from backend.app.services.layout_config import sanitize_node_ordering
from backend.app.services.view_transfer.canonical import (
    config_from_definition, content_hash, portable_definition, split_definition,
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
    #: A draft of the data source to check against (and, when staging, to stage into): its
    #: entities count as there, e.g. the data a view package brought with it.
    branch_id: Optional[str] = None


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


def _canonical(definition: Any, view_type: str) -> Tuple[dict, str]:
    canonical = portable_definition(definition, view_type)
    return canonical, content_hash(canonical)


def _merged(base: dict, ours: dict, theirs: dict, view_type: str) -> Tuple[dict, List[str]]:
    merged = merge_definitions(base, ours, theirs)
    return portable_definition(merged.definition, view_type), merged.conflicts


# Everything below that walks a whole design (canonicalising, hashing, merging, diffing,
# collecting references, reconciling) runs in a worker thread: at the limits each takes up to
# seconds, and on the event loop every other request this worker is serving would wait. Only
# plain data crosses into those threads, never an ORM object.


async def _prepare(session: AsyncSession, item: ReconcileItem) -> Prepared:
    """The definition this item would write, and (when updating) how it stands."""
    incoming, incoming_hash = await asyncio.to_thread(_canonical, item.definition, item.view_type)
    effective = incoming
    update: Optional[Dict[str, Any]] = None
    conflicts: List[str] = []
    row = item.target.view
    working = await view_version_repo.working_state_async(row) if row is not None else None
    if row is not None:
        versions = await target_versions(session, row.id)
        state = update_status(
            incoming_hash=incoming_hash, incoming_history_hashes=item.history_hashes,
            target_working_hash=working.content_hash, target_versions=versions,
        )
        mergeable = state.status == DIVERGED and item.action == "update"
        if item.strategy == "merge" and mergeable:
            base_row = await view_version_repo.get_version(session, row.id, state.base_version)
            base = await asyncio.to_thread(
                view_version_repo.base_definition, base_row.definition, base_row.origin_hash,
                base_row.provenance, state.base_hash)
            effective, conflicts = await asyncio.to_thread(
                _merged, base, working.definition, incoming, item.view_type)
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
        effective = await asyncio.to_thread(
            lambda: portable_definition(rewrite(effective, item.rewrite), item.view_type))
    if update is not None and working is not None:
        update["diff"] = await asyncio.to_thread(
            diff_definitions, working.definition, effective, sample_limit=50)
    return Prepared(item=item, effective=effective, update=update, conflicts=conflicts)


async def _target_facts(session: AsyncSession, target: Target, urns: List[str]):
    """One identity lookup and one ontology read for a target data source."""
    lookup: Dict[str, Optional[dict]] = {}
    types = TargetTypes()
    try:
        engine = await engine_for(session, target.workspace_id, target.data_source_id,
                                  branch_id=target.branch_id)
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

    def graph_of(p: Prepared) -> Tuple[str, Optional[str], Optional[str]]:
        """One lookup per graph read: a data source, as published or as one of its drafts."""
        target = p.item.target
        return target.workspace_id, target.data_source_id, target.branch_id

    groups: Dict[Tuple[str, Optional[str], Optional[str]], List[Prepared]] = {}
    for p in prepared:
        groups.setdefault(graph_of(p), []).append(p)
    facts: Dict[Tuple[str, Optional[str], Optional[str]], tuple] = {}
    for key, members in groups.items():
        urns = await asyncio.to_thread(
            lambda ms=members: sorted({u for m in ms for u in collect(m.effective).urns}))
        facts[key] = await _target_facts(session, members[0].item.target, urns)

    results = []
    reports = []
    for p in prepared:
        lookup, types = facts[graph_of(p)]
        policy = await _policy(session, p.item.view_type)
        report, effective_hash = await asyncio.to_thread(
            lambda p=p, lookup=lookup, types=types, policy=policy: (
                reconcile_view(p.effective, exported=p.item.exported, lookup=lookup, types=types,
                               policy=policy, entities_resolved_at_export=p.item.entities_resolved),
                content_hash(p.effective),
            ))
        reports.append(report)
        results.append({
            "key": p.item.key,
            "effectiveDefinition": p.effective,
            "effectiveHash": effective_hash,
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


async def _prepared(session: AsyncSession, item: ImportItem) -> Tuple[str, dict, str, Optional[dict], List[str]]:
    """The definition as it will be written: canonical, its layer references checked, and held
    to the rules every layout write here obeys. Returns the view type, that definition, the hash
    of what was submitted, the file's own definition (canonical) when sent, and what the rules
    here changed."""
    view_type = item.metadata.get("viewType") or "graph"

    def canonical() -> Tuple[dict, str, Optional[dict], Optional[dict]]:
        definition, submitted_hash = _canonical(item.definition, view_type)
        origin_definition = (portable_definition(item.origin_definition, view_type)
                             if item.origin_definition is not None else None)
        rl = reference_layout(definition)
        if rl is not None:
            view_repo._validate_layer_refs({"layers": rl.get("layers") or [],
                                            "assignments": rl.get("assignments") or {}})
        return definition, submitted_hash, origin_definition, rl

    definition, submitted_hash, origin_definition, rl = await asyncio.to_thread(canonical)
    adjustments: List[str] = []
    if rl is not None:
        sanitized = await view_repo._gate_node_ordering(
            session, await asyncio.to_thread(sanitize_node_ordering, rl))
        if await asyncio.to_thread(lambda: sanitized != rl):
            adjustments.append("Custom node order was dropped: node sorting is turned off here.")
            definition["layout"]["referenceLayout"] = sanitized
    return view_type, definition, submitted_hash, origin_definition, adjustments


async def _locked_target(session: AsyncSession, item: ImportItem) -> ViewORM:
    """The view an update writes to, locked, and refused (409) if it changed since review."""
    row = item.target.view
    assert row is not None
    await session.refresh(row, with_for_update=True)
    if item.expected_target_hash and (
            await view_version_repo.working_state_async(row)).content_hash != item.expected_target_hash:
        raise HTTPException(status_code=409, detail={
            "type": "target_changed",
            "message": f"'{row.name}' changed after you reviewed it. Check it again before importing.",
        })
    return row


@dataclass
class _Facts:
    """What the target graph said about a design's entities and types, and the rules here."""
    lookup: Dict[str, Optional[dict]]
    types: TargetTypes
    policy: Policy


async def _facts_for(session: AsyncSession, item: ImportItem, definition: dict, view_type: str) -> _Facts:
    """Ask the target graph about ``definition``'s entities. Done BEFORE an update takes the view's
    row: the row stays locked until the import commits, and a large view's lookup takes seconds,
    during which a canvas save to that view would wait. Writing never changes which entities a
    design names, so the answer holds for what is then written."""
    urns = await asyncio.to_thread(lambda: sorted(collect(definition).urns))
    lookup, types = await _target_facts(
        session, Target(item.target.workspace_id, item.target.data_source_id, branch_id=item.target.branch_id),
        urns)
    return _Facts(lookup=lookup, types=types, policy=await _policy(session, view_type))


async def _report_on(item: ImportItem, definition: dict, facts: _Facts) -> Dict[str, Any]:
    """How ``definition`` matches the target graph: the authoritative record, taken on what is
    actually written."""
    return await asyncio.to_thread(
        lambda: reconcile_view(definition, exported=item.exported, lookup=facts.lookup, types=facts.types,
                               policy=facts.policy, entities_resolved_at_export=item.entities_resolved))


def _provenance(item: ImportItem, report: Dict[str, Any], adjustments: List[str],
                origin_definition: Optional[dict], written_hash: str) -> Tuple[Dict[str, Any], Dict[str, Any], Optional[str]]:
    """What the import's version records about it, where the file came from, and the file's own
    hash when what was written differs from it (see ``origin_hash``)."""
    origin = {
        "environment": item.provenance.get("environment"),
        "viewId": item.provenance.get("sourceViewId"),
        "version": item.provenance.get("version"),
        "hash": item.provenance.get("definitionHash"),
        "portableId": item.provenance.get("portableId"),
        "exportedAt": item.provenance.get("exportedAt"),
        "exportedBy": item.provenance.get("exportedBy"),
        "fileName": item.provenance.get("fileName"),
    }
    # What was written differs from the file: keep the file's design, so a later file from the
    # same lineage can still merge from it (``view_version_repo.base_definition``).
    origin_hash = content_hash(origin_definition) if origin_definition is not None else None
    diverges = origin_hash is not None and origin_hash != written_hash
    provenance = {
        "origin": origin,
        "ancestry": item.history,
        "action": item.action,
        "strategy": item.strategy,
        "batchId": item.batch_id,
        "forkedFrom": item.provenance.get("forkedFrom"),
        "resolutions": item.resolutions_summary,
        "adjustments": adjustments,
        "report": {"summary": report["summary"], "layers": report["layers"]},
    }
    if diverges:
        provenance["originDefinition"] = origin_definition
    return provenance, origin, origin_hash if diverges else None


def _import_message(origin: Dict[str, Any]) -> str:
    return (f"Imported from {origin['environment'] or 'another environment'}"
            + (f" (v{origin['version']})" if origin.get("version") else ""))


def _import_summary(origin: Dict[str, Any], name: str, match_rate: Optional[float]) -> str:
    return (f"Imported from {origin['environment'] or 'another environment'} · {name}"
            + (f" v{origin['version']}" if origin.get("version") else "")
            + f" · {_pct(match_rate)} matched")


def _integrity(submitted_hash: str, written_hash: str, adjustments: List[str]) -> Dict[str, Any]:
    return {
        "submittedHash": submitted_hash,
        "storedHash": written_hash,
        "verified": written_hash == submitted_hash,
        "adjusted": bool(adjustments),
        "adjustments": adjustments,
    }


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
    view_type, definition, submitted_hash, origin_definition, adjustments = await _prepared(session, item)
    facts = await _facts_for(session, item, definition, view_type)

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
                config=await asyncio.to_thread(config_from_definition, definition, icon=item.metadata.get("icon")),
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
        row = await _locked_target(session, item)
        await view_version_repo.snapshot_if_dirty(session, row, actor=actor,
                                                  message="Saved automatically before importing")
        row.config = await asyncio.to_thread(
            lambda: json.dumps(config_from_definition(definition, icon=item.metadata.get("icon"))))
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

    stored = await view_version_repo.working_state_async(row)
    report = await _report_on(item, stored.definition, facts)
    provenance, origin, origin_hash = _provenance(item, report, adjustments, origin_definition,
                                                  stored.content_hash)
    # What a retry of this request must answer with (see ``replay``).
    provenance.update(submittedHash=submitted_hash, notices=notices)
    version, created = await view_version_repo.checkpoint(
        session, row, source="import", actor=actor, force=True, origin_hash=origin_hash,
        message=_import_message(origin), provenance=provenance, request_id=item.request_id,
    )
    if not created:  # a forced checkpoint only declines when its request id is already taken
        raise AlreadyImported()
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="imported", actor=actor,
        summary=_import_summary(origin, item.provenance.get("name") or row.name, report["summary"]["matchRate"]),
        changes={"action": item.action, "version": version.version, "batchId": item.batch_id},
    )
    return {
        "viewId": row.id,
        "version": view_version_repo.to_summary(version),
        "report": report,
        "notices": notices,
        "integrity": _integrity(submitted_hash, stored.content_hash, adjustments),
    }


# ── Staged in a draft ────────────────────────────────────────────────────────
#
# On a version-controlled data source an import can take the road every other change there
# takes: into a draft, live only when the draft is published or its review merges.
#
#   * An update (or overwrite) is proposed in the importer's own draft for the view (the one
#     the canvas's layer edits use), beside the published design and label it would replace.
#     Nothing live changes; publishing merges it 3-way (``view_repo.promote_overlay``). It
#     supersedes whatever layout that draft proposed for the view before.
#   * A new view is written as it would be live, but private and marked as living only in its
#     own new draft (``draft_branch_id``); it is in no list until the draft goes live, and
#     abandoning the draft discards it.

#: Opens (or finds) the draft a staged import goes into, for the view given.
OpenDraft = Callable[[ViewORM], Awaitable[str]]

#: The visibilities a staged new view can go live with. Publishing to everyone is a governance
#: act of its own, done once the view is live.
STAGED_VISIBILITIES = ("private", "workspace")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _staged_result(row: ViewORM, branch_id: str, staged: Dict[str, Any], *, replayed: bool = False) -> Dict[str, Any]:
    provenance = staged.get("provenance") or {}
    return {
        "viewId": row.id,
        "version": None,
        "report": provenance.get("report") or {},
        "notices": staged.get("notices") or [],
        "integrity": {**(staged.get("integrity") or {}), **({"replayed": True} if replayed else {})},
        "staged": {"branchId": branch_id},
    }


async def stage_update(
    session: AsyncSession,
    item: ImportItem,
    *,
    actor: Optional[str],
    open_draft: OpenDraft,
) -> Dict[str, Any]:
    """Propose an update of a view in the importer's draft for it, in the caller's transaction.

    Checked exactly as a live update is (the same write-side rules, and 409 when the view
    changed since review), but written to the draft's overlay of the view. A retry of the same
    request finds the same draft (a person has one per view) and answers with what it staged.
    """
    view_type, definition, submitted_hash, origin_definition, adjustments = await _prepared(session, item)
    facts = await _facts_for(session, item, definition, view_type)
    # Opened before the view is locked, as the lookup is: it talks to the version store. It is the
    # importer's own draft of this view, found again (not made again) on a retry.
    branch_id = await open_draft(item.target.view)
    row = await _locked_target(session, item)
    overlay = await view_repo.ensure_overlay(session, row.id, branch_id)
    staged_before = json.loads(overlay.staged_provenance) if overlay.staged_provenance else {}
    if item.request_id and staged_before.get("requestId") == item.request_id:
        if staged_before.get("actor") != actor:
            raise HTTPException(status_code=409, detail={
                "type": "request_id_taken", "message": "This request id was already used. Try again.",
            })
        return _staged_result(row, branch_id, staged_before, replayed=True)

    published = await view_version_repo.working_state_async(row)

    def encoded() -> Tuple[str, str, Any, str, str, Any, str]:
        base_rest, base_layout, base_scope = split_definition(published.definition)
        rest, layout, scope = split_definition(definition)
        return (json.dumps(base_rest), json.dumps(base_layout), base_scope,
                json.dumps(rest), json.dumps(layout), scope, content_hash(definition))

    (overlay.fork_base_definition, overlay.fork_base_layout, overlay.fork_base_entity_scope,
     overlay.definition, overlay.reference_layout, overlay.entity_scope,
     written_hash) = await asyncio.to_thread(encoded)
    overlay.fork_base_label = json.dumps(published.label)
    overlay.label = json.dumps({
        "name": item.metadata["name"],
        "description": item.metadata.get("description") or None,
        "icon": item.metadata.get("icon") or None,
        "tags": list(item.metadata.get("tags") or []),
        "viewType": view_type,
    })

    report = await _report_on(item, definition, facts)
    provenance, origin, _ = _provenance(item, report, adjustments, origin_definition, written_hash)
    # Whether the view ends up holding something other than the file is only known once the
    # draft goes live and merges (view_repo.promote_overlay); the file's design waits here.
    provenance.pop("originDefinition", None)
    staged = {
        "kind": "update",
        "action": item.action,
        "requestId": item.request_id,
        "actor": actor,
        "stagedAt": _now(),
        # An overwrite makes the view track the file's view once it goes live.
        "portableId": item.provenance.get("portableId") if item.action == "overwrite" else None,
        "fileDefinition": (origin_definition if origin_definition is not None
                           else await asyncio.to_thread(portable_definition, item.definition, view_type)),
        "message": _import_message(origin),
        "summary": _import_summary(origin, item.provenance.get("name") or row.name, report["summary"]["matchRate"]),
        "provenance": provenance,
        "integrity": _integrity(submitted_hash, written_hash, adjustments),
    }
    overlay.staged_provenance = await asyncio.to_thread(json.dumps, staged)
    await session.flush()
    return {**_staged_result(row, branch_id, staged), "report": report}


async def stage_new(
    session: AsyncSession,
    item: ImportItem,
    *,
    actor: Optional[str],
    ontology_digest: Optional[str],
    open_draft: OpenDraft,
) -> Dict[str, Any]:
    """Import a new view into its own new draft, in the caller's transaction.

    Written as a live import would be (its ``import`` version and all, so a retry of the same
    request replays like one), but private and marked as living only in the draft: it goes
    live, with the visibility asked for here, when that draft is published.
    """
    visibility = item.metadata.get("visibility") or "private"
    if visibility not in STAGED_VISIBILITIES:
        raise HTTPException(status_code=422, detail=(
            "A view imported into a draft goes live as private or shared with its workspace. "
            "Publish it to everyone once it's live."))
    item.metadata = {**item.metadata, "visibility": "private"}
    result = await import_item(session, item, actor=actor, ontology_digest=ontology_digest)
    row = (await session.execute(select(ViewORM).where(ViewORM.id == result["viewId"]))).scalar_one()
    branch_id = await open_draft(row)
    row.draft_branch_id = branch_id
    overlay = await view_repo.ensure_overlay(session, row.id, branch_id)
    overlay.staged_provenance = json.dumps({
        "kind": "create", "action": item.action, "requestId": item.request_id, "actor": actor,
        "stagedAt": _now(), "visibility": visibility,
    })
    await session.flush()
    return {**result, "staged": {"branchId": branch_id}}


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
    provenance = summary.get("provenance") or {}
    # The first attempt's own answer: a retry of an import that had to adjust the design must not
    # come back "verified".
    integrity = _integrity(provenance.get("submittedHash") or version.content_hash,
                           version.content_hash, provenance.get("adjustments") or [])
    return {"viewId": version.view_id, "version": summary, "report": provenance.get("report") or {},
            "notices": provenance.get("notices") or [], "integrity": {**integrity, "replayed": True}}


__all__ = ["AlreadyImported", "Target", "ReconcileItem", "ImportItem", "reconcile_items",
           "import_item", "stage_update", "stage_new", "STAGED_VISIBILITIES", "replay"]
