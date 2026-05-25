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


async def rebase_against_snapshot(
    session: AsyncSession,
    *,
    working_set: GraphWorkingSetORM,
    new_base_commit_id: str | None,
    snapshot,
) -> dict[str, Any]:
    """V1-6 pull: re-anchor a working set against a fresher branch HEAD.

    Walks every staged change in the working set. For each:

    * **clean** — the object's current ``content_hash`` at the new
      HEAD matches the staged ``base_content_hash`` (or both sides
      agree the object doesn't exist). The staged op still applies
      cleanly; update its ``base_content_hash`` to the new value (or
      leave NULL for adds). The op stays in the working set.
    * **dropped** — both sides deleted the same object; the staged
      delete is now a no-op and is removed from the working set.
    * **conflict** — the staged change cannot be auto-applied.
      Categories mirror the merge-engine conflict shape:
      ``edit_edit`` (both modified), ``edit_delete`` (we edited,
      remote deleted), ``delete_edit`` (we deleted, remote edited),
      ``add_add`` (both created independently). The staged op is
      LEFT IN PLACE with its original ``base_content_hash`` so the UI
      can render the conflict and let the user resolve.

    After processing, the working set's ``base_commit_id`` advances
    to ``new_base_commit_id`` and ``ws_change_version`` bumps so
    other tabs notice. Conflicts are returned to the caller; the
    endpoint serializes them in the response shape the frontend
    pull-dialog consumes.
    """
    from backend.app.services.graph_versioning.manifest import partition_for

    previous_base = working_set.base_commit_id
    rows = await list_changes(session, working_set_id=working_set.id)
    if not rows:
        working_set.base_commit_id = new_base_commit_id
        working_set.ws_change_version += 1
        working_set.updated_at = _now()
        return {
            "previous_base": previous_base,
            "new_base": new_base_commit_id,
            "rebased": 0,
            "dropped": 0,
            "conflicts": [],
        }

    rebased = 0
    dropped = 0
    conflicts: list[dict[str, Any]] = []

    for row in rows:
        partition_idx = partition_for(row.object_id, snapshot.partition_count)
        partition = snapshot.partitions.get(partition_idx) if snapshot else None
        entry = (
            partition.entries.get(row.object_id) if partition is not None else None
        )
        current_hash = entry[1] if entry else None
        staged_base = row.base_content_hash
        is_create = row.change_type.startswith("add_")
        is_delete = row.change_type.startswith("delete_")

        # Decide.
        if current_hash is None:
            if is_create:
                # Object didn't exist on either side at staging; still
                # doesn't exist at new HEAD → clean rebase.
                rebased += 1
                continue
            if is_delete:
                # We deleted, remote also no longer has it → drop.
                await session.delete(row)
                dropped += 1
                continue
            # update on a now-deleted object → conflict.
            conflicts.append({
                "object_kind": row.object_kind,
                "object_id": row.object_id,
                "conflict_class": "edit_delete",
                "base_content_hash": staged_base,
                "current_content_hash": None,
                "staged_change_type": row.change_type,
            })
            continue

        if is_create:
            # Object exists at new HEAD but we wanted to create it →
            # add/add collision.
            conflicts.append({
                "object_kind": row.object_kind,
                "object_id": row.object_id,
                "conflict_class": "add_add",
                "base_content_hash": staged_base,
                "current_content_hash": current_hash,
                "staged_change_type": row.change_type,
            })
            continue

        # update or delete: compare staged base with current.
        if staged_base == current_hash:
            # Clean: our op still applies on top of the current state.
            rebased += 1
            continue

        # Mismatch — surface as conflict; keep the staged op + its
        # original base_content_hash so the user can resolve.
        if is_delete:
            klass = "delete_edit"
        else:
            klass = "edit_edit"
        conflicts.append({
            "object_kind": row.object_kind,
            "object_id": row.object_id,
            "conflict_class": klass,
            "base_content_hash": staged_base,
            "current_content_hash": current_hash,
            "staged_change_type": row.change_type,
        })

    working_set.base_commit_id = new_base_commit_id
    working_set.ws_change_version += 1
    working_set.updated_at = _now()

    return {
        "previous_base": previous_base,
        "new_base": new_base_commit_id,
        "rebased": rebased,
        "dropped": dropped,
        "conflicts": conflicts,
    }


__all__ = [
    "get_or_open",
    "stage_changes",
    "list_changes",
    "discard_all",
    "to_ordered_ops",
    "coalesce_decision",
    "rebase_against_snapshot",
]
