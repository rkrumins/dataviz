"""``view_membership_state``: how keeping a view made from a query up to date is going.

One row per such view, created with it (or the first time anything needs it).
Writers:

* the layout paths (``view_repo``) mark a view ``pending`` when its members need
  placing again (a layer they sat in was deleted, a design was restored);
* the refresh pipeline claims a row (``epoch + 1``, a lease) and records its answer
  only while the epoch is still its own — a run that lost its lease, or was
  overtaken, never writes over a newer answer.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewMembershipStateORM, ViewORM


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def later_iso(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def dumps(value: Any) -> Optional[str]:
    return None if value is None else json.dumps(value)


def loads(text: Optional[str]) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


async def get(session: AsyncSession, view_id: str) -> Optional[ViewMembershipStateORM]:
    """The row as it is now. The claim and its release write with bulk UPDATEs, which
    a session's copy of the row does not see: every read refreshes it."""
    return (await session.execute(
        select(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def ensure(session: AsyncSession, row: ViewORM, *, status: str = "pending") -> ViewMembershipStateORM:
    """The view's state row, created if it has none. Two first writers race safely:
    the loser reads the winner's row."""
    state = await get(session, row.id)
    if state is not None:
        return state
    state = ViewMembershipStateORM(
        view_id=row.id, workspace_id=row.workspace_id, data_source_id=row.data_source_id,
        status=status, epoch=0, attempts=0, revision=0, member_count=0, key_count=0,
    )
    try:
        async with session.begin_nested():
            session.add(state)
    except IntegrityError:
        state = await get(session, row.id)
        assert state is not None
    return state


async def mark_pending(session: AsyncSession, row: ViewORM, *, reason: str) -> None:
    """The view's members need working out again (a snapshot stays as it is)."""
    state = await ensure(session, row)
    if state.status == "frozen":
        return
    state.status = "pending"
    state.status_detail = dumps({"reason": reason})
    state.dirty_since = state.dirty_since or now_iso()
    state.due_at = now_iso()


async def claim(session: AsyncSession, view_id: str, *, owner: str, lease_s: float) -> Optional[int]:
    """Take the row for one refresh: ``epoch + 1`` and a lease, unless another run
    holds an unexpired lease. Returns the epoch to fence the answer with, or None."""
    now = now_iso()
    result = await session.execute(
        update(ViewMembershipStateORM)
        .where(
            ViewMembershipStateORM.view_id == view_id,
            or_(ViewMembershipStateORM.lease_until.is_(None), ViewMembershipStateORM.lease_until < now),
        )
        .values(
            epoch=ViewMembershipStateORM.epoch + 1,
            lease_owner=owner,
            lease_until=later_iso(lease_s),
            status="updating",
            last_started_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return None
    state = await get(session, view_id)
    await session.refresh(state)
    return state.epoch if state is not None else None


async def locked_if_mine(
    session: AsyncSession, view_id: str, *, owner: str, epoch: int,
) -> Optional[ViewMembershipStateORM]:
    """The row, locked, only while this run's claim still holds it."""
    state = (await session.execute(
        select(ViewMembershipStateORM)
        .where(and_(ViewMembershipStateORM.view_id == view_id,
                    ViewMembershipStateORM.epoch == epoch,
                    ViewMembershipStateORM.lease_owner == owner))
        .with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    return state


async def release(session: AsyncSession, view_id: str, *, owner: str, epoch: int, **values: Any) -> None:
    """Let go of the claim, recording ``values`` — only while it is still this run's."""
    await session.execute(
        update(ViewMembershipStateORM)
        .where(ViewMembershipStateORM.view_id == view_id,
               ViewMembershipStateORM.epoch == epoch,
               ViewMembershipStateORM.lease_owner == owner)
        .values(lease_owner=None, lease_until=None, last_finished_at=now_iso(), **values)
        .execution_options(synchronize_session=False)
    )
