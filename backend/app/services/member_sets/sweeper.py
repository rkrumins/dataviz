"""Member-set sweep: sets nobody moves on, or nobody has needed for a day, are let go.

A set holds up to a million rows (and twice that in edges), so it cannot be kept
for ever, and it cannot be deleted in one transaction either. Each pass:

* expires every set past its ``expires_at`` — a running set nobody has moved on for
  ``store.IDLE_S``, a complete one ``MEMBER_SET_TTL_HOURS`` after it completed, a
  failed one shortly after it failed — freeing its key, so asking the question
  again starts afresh rather than finding it;
* deletes up to ``_BATCH`` of one expired set's edges, else its rows, else the set
  itself once both are gone;
* else up to ``_BATCH`` of one view's members at an epoch nobody needs any more — one
  its answer was swapped away from, or one a run left behind (nothing changed, it
  started placing again, it was overtaken) — which the run itself did not finish
  deleting. A view keeps the epoch its readers see and the one a run is placing.

Each pass is its own short transaction under an advisory lock (``db/advisory.py``),
so replicas take turns rather than contend for the same rows, and it drains greedily:
pass after pass until nothing is left to do, then it waits for the next tick.

Runs where the other housekeeping sweeps run: the control plane, and a dev-role
monolith, behind ``runs_scheduler``.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import and_, delete, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.advisory import claim_this_pass
from backend.app.db.models import (
    MemberSetEdgeORM,
    MemberSetORM,
    MemberSetRowORM,
    ViewMemberORM,
    ViewMembershipStateORM,
)
from backend.app.db.repositories import view_members_repo
from backend.app.db.repositories.view_membership_repo import now_iso
from backend.app.services.member_sets import store as sets

logger = logging.getLogger(__name__)

# Rows (or edges) deleted per transaction: bounded, so a pass never holds a long one.
_BATCH = 50_000

# A running set is let go after 15 minutes untouched: sweeping every few minutes
# keeps that promise without the sweep showing up anywhere.
_DEFAULT_INTERVAL_SECONDS = 300.0


async def sweep_once(session: AsyncSession, *, batch: int = _BATCH) -> int:
    """One pass: expire what is due, then delete one batch. Returns how much went
    (sets expired, rows, edges and sets deleted)."""
    now = now_iso()
    due = (await session.execute(
        select(MemberSetORM.id).where(MemberSetORM.status.in_(("running", "complete", "failed")),
                                      MemberSetORM.expires_at < now)
    )).scalars().all()
    done = await sets.retire(session, due)

    set_id = (await session.execute(
        select(MemberSetORM.id).where(MemberSetORM.status == "expired")
        .order_by(MemberSetORM.updated_at).limit(1)
    )).scalar_one_or_none()
    if set_id is None:
        return done + await _sweep_view_members(session, batch=batch)
    for model in (MemberSetEdgeORM, MemberSetRowORM):
        first = (await session.execute(
            select(func.min(model.seq)).where(model.set_id == set_id))).scalar()
        if first is not None:
            # A range of ``batch`` seqs holds at most ``batch`` entries: rows and edges
            # share one counter, each value used once.
            result = await session.execute(
                delete(model).where(model.set_id == set_id, model.seq < first + batch)
                .execution_options(synchronize_session=False))
            return done + (result.rowcount or 0)
    await session.execute(delete(MemberSetORM).where(MemberSetORM.id == set_id)
                          .execution_options(synchronize_session=False))
    return done + 1


async def _sweep_view_members(session: AsyncSession, *, batch: int) -> int:
    """Up to ``batch`` rows of the first view epoch nobody needs. A view is looked at
    with index ranges around the epochs it keeps (one per state row: a view made from
    a query), never by reading its members."""
    m, s = ViewMemberORM, ViewMembershipStateORM
    states = (await session.execute(
        select(s.view_id, s.epoch, s.members_epoch, s.materialize.is_not(None)).order_by(s.view_id))).all()
    for view_id, epoch, members_epoch, running in states:
        keep = sorted({e for e in (members_epoch, epoch if running else None) if e is not None})
        if not keep:
            other = true()
        else:
            other = or_(m.epoch < keep[0], m.epoch > keep[-1],
                        and_(m.epoch > keep[0], m.epoch < keep[-1]))
        orphan = (await session.execute(
            select(m.epoch).where(m.view_id == view_id, other).limit(1))).scalar_one_or_none()
        if orphan is not None:
            return await view_members_repo.delete_epoch(session, view_id, orphan, batch=batch)
    return 0


async def run_sweeper(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Background loop: sweep until ``shutdown`` is set.

    Each pass opens its own session (the factory's scope commits on success and
    rolls back on error). A failure is logged and retried on the next tick: a
    transient database blip must not kill the sweeper, and nothing depends on any
    one pass succeeding.
    """
    logger.info("Member-set sweeper started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            while not shutdown.is_set():
                async with session_factory() as session:
                    if not await claim_this_pass(session, "member-sets:sweep"):
                        break  # another process is sweeping
                    swept = await sweep_once(session)
                if not swept:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning("Member-set sweep failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass

    logger.info("Member-set sweeper stopped")
