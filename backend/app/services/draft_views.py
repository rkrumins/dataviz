"""What a draft holds in views, kept in step with what became of the draft.

A draft's view changes (layer edits, and imports staged in it) live in the management database;
the draft itself lives in graph version control. The two share no transaction, so publishing or
abandoning a draft settles its views afterwards, best-effort (see the versioning endpoints'
``_promote_view_layout_overlay`` and ``_drop_view_layout_overlays``). This module finishes what
that left undone:

  * ``discard`` drops what abandoned drafts held: the path for drafts swept for idling, which
    are abandoned in bulk without passing through the abandon endpoint;
  * ``settle`` looks at every draft that holds a staged import and finishes its fate: a merged
    one brings its views live, an abandoned one discards them. Drafts holding only layer edits
    are left as they always were, so an overlay stranded long ago is never merged into a view
    that has moved on since.
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_async_session
from backend.app.db.models import ViewLayoutOverlayORM, ViewORM
from backend.app.db.repositories import view_repo, view_version_repo
from backend.app.services.view_transfer.canonical import content_hash, portable_definition
from backend.app.services.view_transfer.diff import diff_definitions
from backend.app.services.view_transfer.references import definition_stats

if TYPE_CHECKING:  # pragma: no cover — annotation only
    from backend.app.services.versioning.service import GraphVersioningService

logger = logging.getLogger(__name__)


def _loads(text: Optional[str]) -> Dict[str, Any]:
    value = json.loads(text) if text else None
    return value if isinstance(value, dict) else {}


async def changes_on(session: AsyncSession, branch_id: str) -> List[Dict[str, Any]]:
    """What a draft changes in views, beside its graph changes, one entry per view:

    * ``create``: a view that exists only in the draft (an import waiting to go live), with its
      headline counts and the visibility it goes live with;
    * ``update``: an import staged in the draft for a view here, with what it changes;
    * ``layout``: layer edits made in the draft (an overlay that proposes nothing is left out).

    Imports carry where they came from and how well they matched. Rows are ordered by name.
    """
    overlays = {o.view_id: o for o in (await session.execute(
        select(ViewLayoutOverlayORM).where(ViewLayoutOverlayORM.branch_id == branch_id)
    )).scalars()}
    waiting = {v.id: v for v in (await session.execute(
        select(ViewORM).where(ViewORM.draft_branch_id == branch_id, ViewORM.deleted_at.is_(None))
    )).scalars()}
    others = [vid for vid in overlays if vid not in waiting]
    rows = dict(waiting)
    if others:
        rows.update({v.id: v for v in (await session.execute(
            select(ViewORM).where(ViewORM.id.in_(others), ViewORM.deleted_at.is_(None))
        )).scalars()})

    out: List[Dict[str, Any]] = []
    for view_id, row in rows.items():
        overlay = overlays.get(view_id)
        staged = _loads(overlay.staged_provenance) if overlay is not None else {}
        published = view_version_repo.working_state(row)
        proposed = portable_definition(await view_repo.effective_view_config(session, row, branch_id),
                                       row.view_type)
        label = _loads(overlay.label) if overlay is not None and overlay.label else published.label
        entry: Dict[str, Any] = {
            "viewId": row.id, "workspaceId": row.workspace_id, "name": label.get("name") or row.name,
            "stagedBy": staged.get("actor"), "stagedAt": staged.get("stagedAt"),
            "origin": None, "matchRate": None,
        }
        if view_id in waiting:
            head = await view_version_repo.head(session, row.id)
            provenance = (view_version_repo.to_summary(head).get("provenance") or {}) if head else {}
            entry.update(change="create", stats=definition_stats(proposed),
                         goesLiveAs=staged.get("visibility") or "private")
        elif overlay is not None and overlay.definition is not None:
            provenance = staged.get("provenance") or {}
            entry.update(change="update", diff=diff_definitions(
                published.definition, proposed, label_a=published.label, label_b=label))
        else:
            if content_hash(proposed) == published.content_hash:
                continue
            provenance = {}
            entry.update(change="layout", diff=diff_definitions(published.definition, proposed))
        origin = provenance.get("origin") or {}
        if origin:
            entry["origin"] = {"environment": origin.get("environment"), "version": origin.get("version"),
                               "name": origin.get("name") or (provenance.get("report") or {}).get("name")}
        summary = (provenance.get("report") or {}).get("summary") or {}
        entry["matchRate"] = summary.get("matchRate")
        out.append(entry)
    return sorted(out, key=lambda e: (e["name"] or "").lower())


async def discard(branch_ids: Iterable[str]) -> int:
    """Drop the view overlays and staged views of drafts that were abandoned. One transaction per
    draft, so one failure doesn't keep the rest."""
    dropped = 0
    for branch_id in branch_ids:
        try:
            async with get_async_session() as session:
                await view_repo.drop_overlays_for_branch(session, branch_id)
            dropped += 1
        except Exception:  # noqa: BLE001 — the next sweep or settle tries again
            logger.exception("draft views: could not discard the views of draft %s", branch_id)
    return dropped


async def settle(svc: "GraphVersioningService") -> Dict[str, int]:
    """Bring live, or discard, the staged imports of drafts that were merged or abandoned."""
    async with get_async_session() as session:
        staged_overlays = (await session.execute(
            select(ViewLayoutOverlayORM.branch_id).where(ViewLayoutOverlayORM.staged_provenance.is_not(None))
        )).scalars().all()
        staged_views = (await session.execute(
            select(ViewORM.draft_branch_id).where(ViewORM.draft_branch_id.is_not(None))
        )).scalars().all()
    branch_ids = sorted(set(staged_overlays) | set(staged_views))
    if not branch_ids:
        return {"promoted": 0, "discarded": 0}

    statuses = await svc.branch_statuses(branch_ids)
    promoted = 0
    for branch_id in (b for b in branch_ids if statuses.get(b) == "merged"):
        try:
            async with get_async_session() as session:
                await view_repo.promote_overlays_for_branch(session, branch_id)
            promoted += 1
        except Exception:  # noqa: BLE001 — tried again on the next pass
            logger.exception("draft views: could not bring the views of draft %s live", branch_id)
    discarded = await discard(b for b in branch_ids if statuses.get(b) == "abandoned")
    if promoted or discarded:
        logger.info("draft views: settled %d published and %d abandoned draft(s)", promoted, discarded)
    return {"promoted": promoted, "discarded": discarded}


__all__ = ["changes_on", "discard", "settle"]
