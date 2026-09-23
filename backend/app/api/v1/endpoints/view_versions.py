"""View versions: the history of a view's design.

Mounted at ``/api/v1/views/{view_id}/versions``. Not graph version control: drafts, commits
and pull requests version the graph's data; these routes version the view's layers,
assignments and settings, for every view, versioned data source or not.

    GET    ""                 history, newest first, plus whether the view has changed since
    GET    /status            the header chip's answer: latest version, and unsaved changes?
    POST   ""                 "Save version" (a checkpoint with an optional note)
    GET    /compare           what changed between two versions, or a version and now
    GET    /{version}         one version, with its definition
    POST   /{version}/restore go back to a version, as a new version

Reading needs read access to the view; saving and restoring need edit access.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.view_guards import editable_view, readable_view
from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_optional_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import view_activity_repo, view_repo, view_version_repo
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.view_transfer.diff import diff_definitions

logger = logging.getLogger(__name__)
# A preview behind the same switch as moving views between environments (Admin → Features).
# Versions are still RECORDED while it is off (see view_version_repo.checkpoint); only reading
# and restoring them here is refused.
router = APIRouter(dependencies=[Depends(require_feature("viewPortabilityEnabled"))])


class SaveVersionRequest(BaseModel):
    message: Optional[str] = Field(None, max_length=500)


def _actor(user) -> Optional[str]:
    return user.id if user else None


async def _with_names(session: AsyncSession, summaries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Resolve each version's author to a display name in one query."""
    names = await view_repo.resolve_user_ids(session, {s.get("createdBy") for s in summaries})
    for summary in summaries:
        resolved = names.get(summary.get("createdBy") or "")
        summary["createdByName"] = resolved[0] if resolved else None
    return summaries


@router.get("")
async def list_versions(
    view_id: str = Path(...),
    limit: int = Query(50, ge=1, le=200),
    before: Optional[int] = Query(None, ge=1, description="Page below this version number"),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The view's versions, newest first, and how the view differs from the latest.

    A view that predates versioning has no versions yet; its first, a ``baseline`` of how it
    looks now, is taken here, so its history is never empty.
    """
    view = await readable_view(session, view_id, user, claims)
    latest = await view_version_repo.ensure_baseline(session, view)
    rows, has_more = await view_version_repo.list_versions(session, view_id, limit=limit, before=before)
    items = await _with_names(session, [view_version_repo.to_summary(v) for v in rows])
    working = view_version_repo.status(view, latest)
    if working["dirty"]:
        state = view_version_repo.working_state(view)
        latest_full = await view_version_repo.get_version(session, view_id, latest.version)
        working["summary"] = diff_definitions(
            view_version_repo.definition_of(latest_full), state.definition,
            label_a=view_version_repo.label_of(latest_full), label_b=state.label,
            sample_limit=0,
        )
    return {
        "items": items,
        "hasMore": has_more,
        "nextBefore": rows[-1].version if has_more and rows else None,
        "workingCopy": working,
        "portableId": view.portable_id,
    }


@router.get("/status")
async def version_status(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Latest version number and whether the view has unsaved changes since it.

    Cheap enough to back a header chip: one indexed read and one hash of the config. Never
    writes; a view with no history reports ``headVersion: null``.
    """
    view = await readable_view(session, view_id, user, claims)
    latest = await view_version_repo.head(session, view_id)
    result = view_version_repo.status(view, latest)
    result["portableId"] = view.portable_id
    result["origin"] = await _origin(session, view_id)
    return result


async def _origin(session: AsyncSession, view_id: str) -> Optional[Dict[str, Any]]:
    """Where the view last came from, when it was imported: the chip's "from dev v12"."""
    imported = await view_version_repo.latest_of_source(session, view_id, "import")
    if imported is None:
        return None
    provenance = view_version_repo.to_summary(imported).get("provenance") or {}
    origin = provenance.get("origin") if isinstance(provenance, dict) else None
    if not isinstance(origin, dict):
        return None
    return {**origin, "importedAsVersion": imported.version, "importedAt": imported.created_at}


@router.post("")
async def save_version(
    view_id: str = Path(...),
    req: SaveVersionRequest = Body(default_factory=SaveVersionRequest),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Save the view's current design as a version, with an optional note.

    Nothing changed since the latest version means nothing is written: the response carries
    that version with ``created: false``, so the UI can say so instead of adding a duplicate.
    """
    view = await editable_view(session, view_id, user, claims)
    await view_version_repo.ensure_baseline(session, view)
    version, created = await view_version_repo.checkpoint(
        session, view, source="manual", actor=_actor(user), message=req.message,
    )
    if created:
        await view_activity_repo.record_view_activity(
            session, view_id=view.id, workspace_id=view.workspace_id, action="version_saved",
            actor=_actor(user),
            summary=f"Saved v{version.version}" + (f": {req.message}" if req.message else ""),
            changes={"version": version.version},
        )
    summary = (await _with_names(session, [view_version_repo.to_summary(version)]))[0]
    return {"version": summary, "created": created}


@router.get("/compare")
async def compare_versions(
    view_id: str = Path(...),
    from_version: int = Query(..., alias="from", ge=1),
    to_version: Union[int, str] = Query("working", alias="to"),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """What changed from version ``from`` to version ``to`` (or to the view as it is now)."""
    view = await readable_view(session, view_id, user, claims)
    before = await view_version_repo.get_version(session, view_id, from_version)
    if before is None:
        raise HTTPException(status_code=404, detail=f"Version {from_version} not found")
    if to_version == "working":
        state = view_version_repo.working_state(view)
        after_definition, after_label = state.definition, state.label
    else:
        try:
            number = int(to_version)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="'to' must be a version number or 'working'")
        after = await view_version_repo.get_version(session, view_id, number)
        if after is None:
            raise HTTPException(status_code=404, detail=f"Version {number} not found")
        after_definition, after_label = view_version_repo.definition_of(after), view_version_repo.label_of(after)
    return {
        "from": from_version,
        "to": to_version,
        "diff": diff_definitions(
            view_version_repo.definition_of(before), after_definition,
            label_a=view_version_repo.label_of(before), label_b=after_label,
        ),
    }


@router.get("/{version}")
async def get_version(
    view_id: str = Path(...),
    version: int = Path(..., ge=1),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    await readable_view(session, view_id, user, claims)
    row = await view_version_repo.get_version(session, view_id, version)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Version {version} not found")
    summary = (await _with_names(session, [view_version_repo.to_summary(row)]))[0]
    summary["definition"] = view_version_repo.definition_of(row)
    return summary


@router.post("/{version}/restore")
async def restore_version(
    view_id: str = Path(...),
    version: int = Path(..., ge=1),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Make an earlier version the view's design again.

    The restore is itself a new version, so nothing is rewritten, and any unsaved changes are
    saved as a version first, so nothing is lost. Visibility is left alone.
    """
    view = await editable_view(session, view_id, user, claims)
    try:
        result = await view_version_repo.restore(
            session, view, version, actor=_actor(user),
            gate_layout=view_repo._gate_node_ordering,
        )
    except LookupError:
        raise HTTPException(status_code=404, detail=f"Version {version} not found")
    new_version = result["version"]
    await view_activity_repo.record_view_activity(
        session, view_id=view.id, workspace_id=view.workspace_id, action="version_restored",
        actor=_actor(user), summary=f"Restored v{version} as v{new_version.version}",
        changes={"restoredFrom": version, "version": new_version.version},
    )
    snapshot = result["snapshot"]
    return {
        "view": await view_repo.get_view_enriched(session, view_id, user_id=_actor(user)),
        "version": (await _with_names(session, [view_version_repo.to_summary(new_version)]))[0],
        "snapshot": view_version_repo.to_summary(snapshot) if snapshot is not None else None,
    }
