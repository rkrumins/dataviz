"""Repository: access_reviews and access_review_items.

A workspace admin's review of who holds access to the workspace: the grants
as they stood when it began, each kept or removed. One open review per
workspace — a partial unique index holds the rule.

No business logic: the endpoints decide who may review, what removing a
grant does, and when a review may complete.
"""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AccessReviewItemORM, AccessReviewORM


async def get_open(session: AsyncSession, workspace_id: str) -> Optional[AccessReviewORM]:
    return (await session.execute(
        select(AccessReviewORM).where(
            AccessReviewORM.workspace_id == workspace_id, AccessReviewORM.status == "open",
        )
    )).scalars().first()


async def create(
    session: AsyncSession,
    *,
    workspace_id: str,
    started_by: str,
    started_at: str,
    due_at: str,
    items: Iterable[dict],
) -> Optional[AccessReviewORM]:
    """Open a review with its items. ``None`` when one is already open —
    two admins starting at once included: the loser's insert fails inside a
    savepoint."""
    review = AccessReviewORM(
        workspace_id=workspace_id, status="open", started_by=started_by,
        started_at=started_at, due_at=due_at,
    )
    try:
        async with session.begin_nested():
            session.add(review)
            await session.flush()
    except IntegrityError:
        return None
    session.add_all(AccessReviewItemORM(review_id=review.id, **item) for item in items)
    await session.flush()
    return review


async def get(
    session: AsyncSession, review_id: str, *, for_update: bool = False,
) -> Optional[AccessReviewORM]:
    stmt = select(AccessReviewORM).where(AccessReviewORM.id == review_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_for_workspace(
    session: AsyncSession, workspace_id: str, *, limit: int = 20,
) -> list[AccessReviewORM]:
    """The workspace's reviews, newest first."""
    return list((await session.execute(
        select(AccessReviewORM)
        .where(AccessReviewORM.workspace_id == workspace_id)
        .order_by(AccessReviewORM.started_at.desc())
        .limit(limit)
    )).scalars().all())


async def list_items(session: AsyncSession, review_id: str) -> list[AccessReviewItemORM]:
    return list((await session.execute(
        select(AccessReviewItemORM).where(AccessReviewItemORM.review_id == review_id)
    )).scalars().all())


async def get_item(
    session: AsyncSession, review_id: str, item_id: str, *, for_update: bool = False,
) -> Optional[AccessReviewItemORM]:
    stmt = select(AccessReviewItemORM).where(
        AccessReviewItemORM.id == item_id, AccessReviewItemORM.review_id == review_id,
    )
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def counts(session: AsyncSession, review_ids: Iterable[str]) -> dict[str, dict[str, int]]:
    """``{review: {total, kept, removed, undecided}}`` in one query."""
    ids = list(review_ids)
    out = {rid: {"total": 0, "kept": 0, "removed": 0, "undecided": 0} for rid in ids}
    if not ids:
        return out
    rows = (await session.execute(
        select(AccessReviewItemORM.review_id, AccessReviewItemORM.decision, func.count())
        .where(AccessReviewItemORM.review_id.in_(ids))
        .group_by(AccessReviewItemORM.review_id, AccessReviewItemORM.decision)
    )).all()
    key = {"keep": "kept", "remove": "removed", None: "undecided"}
    for rid, decision, n in rows:
        out[rid][key[decision]] += n
        out[rid]["total"] += n
    return out
