"""``view_membership_state``: how keeping a view made from a query up to date is going.

One row per such view, created with it (or the first time anything needs it).
Writers:

* the layout paths (``view_repo``) mark a view ``pending`` when its members need
  placing again (a layer they sat in was deleted, a design was restored, the view it
  follows changed how it places entities);
* the refresh pipeline claims a row (``epoch + 1``, a lease) and records its answer
  only while the epoch is still its own — a run that lost its lease, or was
  overtaken, never writes over a newer answer. A run too large for one request
  keeps how far it got in ``materialize``; the next request takes it over at the
  same epoch once its lease is free (``take_over``).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional, Sequence

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewMembershipStateORM, ViewORM, view_is_live


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


async def followers(session: AsyncSession, view_id: str) -> List[str]:
    """The views made from a query that follow ``view_id`` (``layout.kind: follow``): live
    views among its subsets (``subset_of``)."""
    from backend.common.models.view_membership import read_definition

    out: List[str] = []
    for follower_id, text in (await session.execute(
            select(ViewORM.id, ViewORM.config).where(ViewORM.subset_of == view_id, view_is_live()))).all():
        config = loads(text)
        definition = read_definition(config) if isinstance(config, dict) else None
        if definition is not None and definition.layout.kind == "follow":
            out.append(follower_id)
    return out


async def mark_followers_pending(session: AsyncSession, view_ids: Sequence[str]) -> int:
    """The views ``view_ids`` follow a view that changed how it places entities: each is out
    of date (``base_changed``) until it is next opened — in one statement, however many
    there are. A snapshot stays as it is, and one a run is working out now is left to it:
    the run places its pages again when what it follows changes. Returns how many."""
    if not view_ids:
        return 0
    state = ViewMembershipStateORM
    result = await session.execute(
        update(state)
        .where(state.view_id.in_(list(view_ids)), state.status.notin_(("frozen", "updating")),
               or_(state.lease_until.is_(None), state.lease_until < now_iso()))
        .values(status="pending", status_detail=dumps({"reason": "base_changed"}))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0


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


def in_progress(state: Optional[ViewMembershipStateORM], resolution_hash: str) -> Optional[dict]:
    """How far the run at the row's epoch has got, while it is still working out
    ``resolution_hash`` — else None (no run, or one for a question nobody asks now)."""
    progress = loads(state.materialize) if state is not None else None
    if (isinstance(progress, dict) and progress.get("epoch") == state.epoch
            and progress.get("hash") == resolution_hash):
        return progress
    return None


async def take_over(session: AsyncSession, view_id: str, *, owner: str, epoch: int, lease_s: float) -> bool:
    """Carry on the run at ``epoch`` — no new epoch: its pages so far stand — when
    nobody holds its lease, or its holder's ran out."""
    now = now_iso()
    result = await session.execute(
        update(ViewMembershipStateORM)
        .where(
            ViewMembershipStateORM.view_id == view_id, ViewMembershipStateORM.epoch == epoch,
            or_(ViewMembershipStateORM.lease_until.is_(None), ViewMembershipStateORM.lease_until < now),
        )
        .values(lease_owner=owner, lease_until=later_iso(lease_s), status="updating")
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def update_mine(session: AsyncSession, view_id: str, *, owner: str, epoch: int, **values: Any) -> bool:
    """Record ``values`` only while the claim is still this run's: the fence a page of
    members writes through. False: overtaken — the caller rolls its page back."""
    result = await session.execute(
        update(ViewMembershipStateORM)
        .where(ViewMembershipStateORM.view_id == view_id, ViewMembershipStateORM.epoch == epoch,
               ViewMembershipStateORM.lease_owner == owner)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


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
