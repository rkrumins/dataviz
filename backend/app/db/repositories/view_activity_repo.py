"""Per-view activity log — durable timeline + shared Event Log emit.

Records one immutable row per view mutation into ``view_activity_log`` (the
timeline's source of truth) AND emits a ``visualization.view.<action>`` event
to the shared outbox in the SAME transaction. The two are deliberately
decoupled: the timeline read path (:func:`get_view_activity`) touches only
``view_activity_log``; the outbox carries the same event for any app-wide
consumer. If the outbox contract ever changes, the timeline is unaffected.

Mirrors the proven ``ontology_audit_log`` pattern (a dedicated per-entity
audit table with a recorder called at each mutation + a reader).
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any, Optional

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewActivityLogORM, ViewORM
from backend.app.db.repositories import outbox_event_repo
from backend.app.db.repositories.view_repo import resolve_user_ids
from backend.app.services.view_access import readable_views_predicate

if TYPE_CHECKING:
    from backend.app.services.view_access import ViewReadScope

logger = logging.getLogger(__name__)

# Kept in sync with the ck_val_action_enum CHECK constraint and the outbox
# ``visualization.view.<action>`` verbs.
ACTIONS = frozenset({
    "created", "updated", "visibility_changed", "shared", "unshared",
    "favourited", "unfavourited", "deleted", "restored", "data_changed",
})


class ViewActivityEntry(BaseModel):
    id: str
    viewId: str
    action: str
    actor: Optional[str] = None
    actorName: Optional[str] = None
    actorEmail: Optional[str] = None
    summary: Optional[str] = None
    changes: Optional[Any] = None
    createdAt: str
    # Populated only in the workspace-wide feed (redundant in a per-view view).
    viewName: Optional[str] = None
    # View names are NOT unique. Two different views can both be called "Data
    # Lineage", and a feed that names one without saying where it lives is
    # ambiguous. The client already holds the workspace list, so the id is
    # enough — it resolves the name itself.
    workspaceId: Optional[str] = None
    # True for synthesized legacy anchors (no real row existed).
    synthetic: bool = False


async def record_view_activity(
    session: AsyncSession,
    *,
    view_id: str,
    workspace_id: Optional[str],
    action: str,
    actor: Optional[str] = None,
    summary: Optional[str] = None,
    changes: Optional[dict] = None,
) -> None:
    """Append a durable activity row AND emit the shared Event Log event.

    Best-effort: a recording failure must never break the underlying view
    mutation (the timeline is an audit aid, not part of the write contract).
    Both writes are ``session.add`` — durability follows the caller's commit.
    """
    if action not in ACTIONS:
        logger.warning("record_view_activity: unknown action %r for view %s", action, view_id)
        return
    try:
        session.add(ViewActivityLogORM(
            view_id=view_id,
            workspace_id=workspace_id,
            action=action,
            actor=actor,
            summary=summary,
            changes=json.dumps(changes) if changes else None,
        ))
        # Shared, consistent app-wide capture — same transaction, no coupling
        # of the read path. `emit` only session.add's, so it won't do I/O here.
        await outbox_event_repo.emit(
            session,
            event_type=f"visualization.view.{action}",
            aggregate_id=view_id,
            aggregate_type="view",
            payload={
                "workspaceId": workspace_id,
                "actor": actor,
                "summary": summary,
                "changes": changes,
            },
        )
        await session.flush()
    except Exception:  # noqa: BLE001 — never fail the mutation on audit error
        logger.exception("record_view_activity failed (view=%s action=%s)", view_id, action)


async def get_view_activity(
    session: AsyncSession,
    view_id: str,
    *,
    action: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[ViewActivityEntry]:
    """Return a view's activity, newest first, actors resolved to names.

    When no rows exist (legacy views that pre-date activity tracking) a single
    synthesized ``created`` anchor is derived from the view's own stamps so the
    timeline is never blank.
    """
    q = (
        select(ViewActivityLogORM)
        .where(ViewActivityLogORM.view_id == view_id)
    )
    if action:
        q = q.where(ViewActivityLogORM.action == action)
    q = q.order_by(ViewActivityLogORM.created_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(q)).scalars().all()

    if not rows and offset == 0 and not action:
        anchor = await _synthetic_anchor(session, view_id)
        return anchor

    actor_map = await resolve_user_ids(session, {r.actor for r in rows})
    return [_to_entry(r, actor_map) for r in rows]


def _to_entry(
    r: ViewActivityLogORM,
    actor_map: dict,
    *,
    synthetic: bool = False,
) -> ViewActivityEntry:
    name, email = actor_map.get(r.actor or "", (None, None))
    return ViewActivityEntry(
        id=r.id,
        viewId=r.view_id,
        action=r.action,
        actor=r.actor,
        actorName=name,
        actorEmail=email,
        summary=r.summary,
        changes=json.loads(r.changes) if r.changes else None,
        createdAt=r.created_at,
        workspaceId=r.workspace_id,
        synthetic=synthetic,
    )


async def get_workspace_activity(
    session: AsyncSession,
    workspace_id: str,
    *,
    scope: "ViewReadScope",
    limit: int = 30,
    offset: int = 0,
) -> list[ViewActivityEntry]:
    """Recent activity across the workspace's views the caller can READ.

    ``scope`` is required, not optional, for the same reason every other
    multi-view read takes one: this used to return activity for *all* of a
    workspace's views to anyone holding ``workspace:view:read`` there, so a
    ``workspace_viewer`` could read the timeline of a colleague's ``private``
    view — its name, its renames, and ``Shared with alice@acme.com (editor)``
    lines — while ``GET /views/{id}`` on the same view correctly 404'd them.

    Filtered in SQL rather than after the query so ``limit``/``offset`` page
    over the authorized rows; trimming afterwards would return short pages and
    let the caller infer how much they were denied.
    """
    rows = (await session.execute(
        select(ViewActivityLogORM)
        .join(ViewORM, ViewORM.id == ViewActivityLogORM.view_id)
        .where(
            ViewActivityLogORM.workspace_id == workspace_id,
            readable_views_predicate(scope),
        )
        .order_by(ViewActivityLogORM.created_at.desc())
        .limit(limit).offset(offset)
    )).scalars().all()
    if not rows:
        return []
    actor_map = await resolve_user_ids(session, {r.actor for r in rows})
    # Batch-resolve view names.
    view_ids = {r.view_id for r in rows}
    name_rows = (await session.execute(
        select(ViewORM.id, ViewORM.name).where(ViewORM.id.in_(view_ids))
    )).all()
    names = {vid: name for vid, name in name_rows}
    out: list[ViewActivityEntry] = []
    for r in rows:
        e = _to_entry(r, actor_map)
        e.viewName = names.get(r.view_id)
        out.append(e)
    return out


async def get_recent_activity(
    session: AsyncSession,
    *,
    limit: int = 60,
) -> list[tuple[ViewActivityEntry, ViewORM]]:
    """Most recent activity across ALL live views — the dashboard's "What
    changed" feed.

    Returns each entry paired with its ViewORM so the CALLER can apply the same
    per-view read check the views list uses (``view_access.can_read_view``). This
    read is deliberately un-scoped; scoping is the endpoint's job, so a feed can
    never surface a view the user isn't allowed to see.
    """
    rows = (await session.execute(
        select(ViewActivityLogORM, ViewORM)
        .join(ViewORM, ViewORM.id == ViewActivityLogORM.view_id)
        .where(ViewORM.deleted_at.is_(None))
        .order_by(ViewActivityLogORM.created_at.desc())
        .limit(limit)
    )).all()
    if not rows:
        return []

    actor_map = await resolve_user_ids(session, {log.actor for log, _ in rows})
    out: list[tuple[ViewActivityEntry, ViewORM]] = []
    for log, view in rows:
        entry = _to_entry(log, actor_map)
        entry.viewName = view.name
        out.append((entry, view))
    return out


async def _synthetic_anchor(
    session: AsyncSession, view_id: str,
) -> list[ViewActivityEntry]:
    """Derive a 'created' (and optional 'updated') anchor from the view's own
    created_by/updated_by stamps so a legacy view isn't a blank timeline."""
    row = (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one_or_none()
    if row is None:
        return []
    actor_map = await resolve_user_ids(session, {row.created_by, row.updated_by})
    out: list[ViewActivityEntry] = []
    if row.updated_by and row.updated_at and row.updated_at != row.created_at:
        un, ue = actor_map.get(row.updated_by, (None, None))
        out.append(ViewActivityEntry(
            id=f"{view_id}:anchor-updated", viewId=view_id, action="updated",
            actor=row.updated_by, actorName=un, actorEmail=ue,
            summary="Last edited before activity tracking",
            createdAt=row.updated_at, workspaceId=row.workspace_id, synthetic=True,
        ))
    cn, ce = actor_map.get(row.created_by or "", (None, None))
    out.append(ViewActivityEntry(
        id=f"{view_id}:anchor-created", viewId=view_id, action="created",
        actor=row.created_by, actorName=cn, actorEmail=ce,
        summary="Created before activity tracking",
        createdAt=row.created_at, workspaceId=row.workspace_id, synthetic=True,
    ))
    return out
