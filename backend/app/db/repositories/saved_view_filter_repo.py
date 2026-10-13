"""A person's saved Explorer filters — named filter sets kept on the server, so
they follow their owner to any browser.

Every function takes the owner's user id and reaches only that person's rows:
one person can never read, rename, reorder or delete another's, and the router
answers a miss the same way whichever it was. The cap, the names' uniqueness and
the ordering live here, so the router stays thin.
"""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import SavedViewFilterORM, _now

# A list that fits a popover, not an archive.
MAX_FILTERS = 30
_NAME_MAX = 80
# Room for the Explorer's whole filter address, while a row stays small.
_QUERY_MAX = 2000


class SavedFilterError(Exception):
    """A request refused here: ``status`` is the HTTP answer, ``detail`` the
    sentence the Explorer shows the person as it is."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _clean_name(name: str) -> str:
    name = name.strip()
    if not 1 <= len(name) <= _NAME_MAX:
        raise SavedFilterError(422, f"A saved filter's name must be 1 to {_NAME_MAX} characters.")
    return name


def _check_query(query: str) -> str:
    if len(query) > _QUERY_MAX:
        raise SavedFilterError(
            422, f"A saved filter's query must be at most {_QUERY_MAX} characters.",
        )
    return query


def _duplicate(name: str) -> SavedFilterError:
    return SavedFilterError(409, f'You already have a saved filter called "{name}".')


def _check_unused(rows: List[SavedViewFilterORM], name: str, *, besides: Optional[str] = None) -> None:
    """Names compare case-insensitively after trimming. Checked here, before
    writing: the table's unique (user_id, name) matches only the exact same
    spelling, which is what two requests racing past this check would write."""
    folded = name.casefold()
    for row in rows:
        if row.id != besides and row.name.casefold() == folded:
            raise _duplicate(row.name)


async def _write(session: AsyncSession, row: SavedViewFilterORM) -> None:
    """Flush in a savepoint, so the unique (user_id, name) firing for a racing
    request becomes the same refusal and leaves the transaction usable."""
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except IntegrityError:
        raise _duplicate(row.name) from None


async def list_filters(session: AsyncSession, user_id: str) -> List[SavedViewFilterORM]:
    """The person's filters in their order (creation breaks a tie two racing
    creates could leave)."""
    return list((await session.execute(
        select(SavedViewFilterORM)
        .where(SavedViewFilterORM.user_id == user_id)
        .order_by(SavedViewFilterORM.position, SavedViewFilterORM.created_at)
    )).scalars())


async def _own(session: AsyncSession, user_id: str, filter_id: str) -> Optional[SavedViewFilterORM]:
    return (await session.execute(
        select(SavedViewFilterORM).where(
            SavedViewFilterORM.id == filter_id, SavedViewFilterORM.user_id == user_id,
        )
    )).scalar_one_or_none()


async def create_filter(
    session: AsyncSession, user_id: str, *, name: str, query: str,
) -> SavedViewFilterORM:
    """Save a filter last in the person's list."""
    name, query = _clean_name(name), _check_query(query)
    rows = await list_filters(session, user_id)
    _check_unused(rows, name)
    if len(rows) >= MAX_FILTERS:
        raise SavedFilterError(
            409, f"You can keep up to {MAX_FILTERS} saved filters. Delete one to save another.",
        )
    row = SavedViewFilterORM(user_id=user_id, name=name, query=query, position=len(rows))
    await _write(session, row)
    return row


async def update_filter(
    session: AsyncSession, user_id: str, filter_id: str, *,
    name: Optional[str] = None, query: Optional[str] = None,
) -> Optional[SavedViewFilterORM]:
    """A new name, a new query, or both; None when the person has no such filter."""
    row = await _own(session, user_id, filter_id)
    if row is None:
        return None
    if name is not None:
        name = _clean_name(name)
    if query is not None:
        query = _check_query(query)
    if name is not None:
        _check_unused(await list_filters(session, user_id), name, besides=row.id)
        row.name = name
    if query is not None:
        row.query = query
    if name is not None or query is not None:
        row.updated_at = _now()
    await _write(session, row)
    return row


async def reorder_filters(
    session: AsyncSession, user_id: str, ids: List[str],
) -> List[SavedViewFilterORM]:
    """Put the person's filters in the order ``ids`` names them — all of them,
    once each; anything else would leave some position unspoken for."""
    rows = await list_filters(session, user_id)
    if len(ids) != len(set(ids)) or set(ids) != {row.id for row in rows}:
        raise SavedFilterError(
            422, "List each of your saved filters exactly once, in the new order.",
        )
    by_id = {row.id: row for row in rows}
    for position, filter_id in enumerate(ids):
        by_id[filter_id].position = position
    await session.flush()
    return [by_id[filter_id] for filter_id in ids]


async def delete_filter(session: AsyncSession, user_id: str, filter_id: str) -> bool:
    """Delete one, and close up the positions behind it; False when the person
    has no such filter."""
    row = await _own(session, user_id, filter_id)
    if row is None:
        return False
    await session.delete(row)
    await session.flush()
    for position, rest in enumerate(await list_filters(session, user_id)):
        rest.position = position
    await session.flush()
    return True
