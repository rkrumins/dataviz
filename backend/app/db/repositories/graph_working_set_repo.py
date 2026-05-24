"""Repository: per-(graph, branch, user) working set — the Git-style
persisted, isolated index of uncommitted changes.

One working set per (graph, branch, user) (UNIQUE enforced by the
schema). Staged ops are ordered by ``seq``; ``ws_change_version`` is a
coarse optimistic guard the canvas uses to detect "someone/something
else touched my working set since my last sync" before pushing more.

Caller owns the transaction (Graph Store session).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models_graph import (
    GraphWorkingChangeORM,
    GraphWorkingSetORM,
)
from backend.app.db.repositories import graph_store_outbox_repo

_VALID_CHANGE_TYPES = {
    "add_node", "update_node", "delete_node",
    "add_edge", "update_edge", "delete_edge",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def coalesce_decision(existing_change_type: str, incoming_change_type: str) -> str:
    """Pure, unit-testable decision for what to do when re-staging the
    same object. Mirrors `git add` semantics + the frontend
    `graphEditorStore.applyOp` coalescing:

    * ``add → delete``  → **drop** the existing row entirely (add + rm
      of an uncommitted object cancels out — never produces a row
      that says "delete X" for an X that was never committed; would
      crash ``apply_changes`` at commit time).
    * ``add → update``  → **replace_keep_add** (still an add, just with
      a refreshed payload).
    * ``add → add``     → **replace** (last-write-wins on the payload).
    * anything → delete → **replace** (existing intent overwritten by
      the delete).
    * everything else   → **replace** (last-write-wins).

    Returns one of ``{"replace", "drop", "replace_keep_add"}``.
    Caller maps "drop" to a row delete, "replace_keep_add" to an
    UPDATE that keeps the original ``change_type='add_*'`` but takes
    the new payload, and "replace" to a straight field update.
    """
    is_add = existing_change_type.startswith("add_")
    inc_is_delete = incoming_change_type.startswith("delete_")
    inc_is_update = incoming_change_type.startswith("update_")
    if is_add and inc_is_delete:
        return "drop"
    if is_add and inc_is_update:
        return "replace_keep_add"
    return "replace"


async def get_or_open(
    session: AsyncSession,
    *,
    graph_id: str,
    branch: str,
    user_id: str,
    base_commit_id: str | None,
) -> GraphWorkingSetORM:
    """Return the user's open working set on this branch, creating it
    (pinned to *base_commit_id*) if absent."""
    ws = (
        await session.execute(
            select(GraphWorkingSetORM).where(
                GraphWorkingSetORM.graph_id == graph_id,
                GraphWorkingSetORM.branch == branch,
                GraphWorkingSetORM.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if ws is not None:
        return ws
    ws = GraphWorkingSetORM(
        id=f"gws_{uuid.uuid4().hex[:12]}",
        graph_id=graph_id,
        branch=branch,
        user_id=user_id,
        base_commit_id=base_commit_id,
        status="open",
        ws_change_version=0,
        created_at=_now(),
        updated_at=_now(),
    )
    session.add(ws)
    return ws


async def _next_seq(session: AsyncSession, working_set_id: str) -> int:
    cur = (
        await session.execute(
            select(func.max(GraphWorkingChangeORM.seq)).where(
                GraphWorkingChangeORM.working_set_id == working_set_id
            )
        )
    ).scalar()
    return (cur or 0) + 1


async def stage_changes(
    session: AsyncSession,
    *,
    working_set: GraphWorkingSetORM,
    changes: Sequence[Mapping[str, Any]],
    actor: str | None = None,
) -> int:
    """Append ops to the working set. Each change = ``{change_type,
    object_kind, object_id, payload, summary?, base_content_hash?}``.
    Returns the new ``ws_change_version``.

    Per-(object) coalescing mirrors the frontend stagedChangesStore:
    re-staging the same object replaces its prior pending op (the last
    write wins within the working set) so the op list stays bounded by
    distinct touched objects, not edit keystrokes.
    """
    if working_set.status != "open":
        raise ValueError(f"working set is {working_set.status}, not open")

    for ch in changes:
        ct = ch["change_type"]
        if ct not in _VALID_CHANGE_TYPES:
            raise ValueError(f"invalid change_type {ct!r}")
        obj_kind = ch["object_kind"]
        obj_id = ch["object_id"]

        existing = (
            await session.execute(
                select(GraphWorkingChangeORM).where(
                    GraphWorkingChangeORM.working_set_id == working_set.id,
                    GraphWorkingChangeORM.object_kind == obj_kind,
                    GraphWorkingChangeORM.object_id == obj_id,
                )
            )
        ).scalar_one_or_none()

        if existing is not None:
            decision = coalesce_decision(existing.change_type, ct)
            if decision == "drop":
                # add → delete of an uncommitted object: cancel out.
                # Bumping ws_change_version below still signals that
                # the working set changed (other tabs refetch).
                await session.delete(existing)
            elif decision == "replace_keep_add":
                # add → update: stay as 'add_*' with the new payload.
                existing.after_blob = ch.get("payload")
                existing.summary = ch.get("summary", existing.summary)
            else:
                # Coalesce: keep original seq + before_blob, replace intent.
                existing.change_type = ct
                existing.after_blob = ch.get("payload")
                existing.summary = ch.get("summary", existing.summary)
        else:
            session.add(
                GraphWorkingChangeORM(
                    id=f"gwc_{uuid.uuid4().hex[:12]}",
                    working_set_id=working_set.id,
                    change_type=ct,
                    object_kind=obj_kind,
                    object_id=obj_id,
                    base_content_hash=ch.get("base_content_hash"),
                    before_blob=ch.get("before_blob"),
                    after_blob=ch.get("payload"),
                    summary=ch.get("summary", ""),
                    seq=await _next_seq(session, working_set.id),
                    created_at=_now(),
                )
            )

    working_set.ws_change_version += 1
    working_set.updated_at = _now()

    # Per-user signal so the same user's other tabs learn the working
    # set advanced. The SSE subscriber filters by payload.user_id so
    # only the originating user's tabs react. aggregate_id = graph_id
    # (cross-table convention); entity = working_set.
    await graph_store_outbox_repo.emit(
        session,
        event_type="visualization.working_set.advanced",
        aggregate_id=working_set.graph_id,
        payload={
            "graph_id": working_set.graph_id,
            "branch": working_set.branch,
            "user_id": working_set.user_id,
            "ws_change_version": working_set.ws_change_version,
        },
    )

    return working_set.ws_change_version


async def list_changes(
    session: AsyncSession, *, working_set_id: str
) -> Sequence[GraphWorkingChangeORM]:
    return (
        (
            await session.execute(
                select(GraphWorkingChangeORM)
                .where(GraphWorkingChangeORM.working_set_id == working_set_id)
                .order_by(GraphWorkingChangeORM.seq)
            )
        )
        .scalars()
        .all()
    )


async def discard_all(
    session: AsyncSession, *, working_set: GraphWorkingSetORM
) -> None:
    """Drop every staged change (working set stays open, base intact)."""
    from sqlalchemy import delete

    await session.execute(
        delete(GraphWorkingChangeORM).where(
            GraphWorkingChangeORM.working_set_id == working_set.id
        )
    )
    working_set.ws_change_version += 1
    working_set.updated_at = _now()


async def to_ordered_ops(
    session: AsyncSession, *, working_set_id: str
) -> list[dict]:
    """Working changes as the ordered op dicts ``apply_changes``
    consumes."""
    rows = await list_changes(session, working_set_id=working_set_id)
    return [
        {
            "change_type": r.change_type,
            "object_kind": r.object_kind,
            "object_id": r.object_id,
            "payload": r.after_blob or {"key": r.object_id},
            "base_content_hash": r.base_content_hash,
        }
        for r in rows
    ]


__all__ = [
    "get_or_open",
    "stage_changes",
    "list_changes",
    "discard_all",
    "to_ordered_ops",
    "coalesce_decision",
]
