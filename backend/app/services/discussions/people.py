"""The ``people`` map every conversations payload carries: each person it names, once."""
from __future__ import annotations

from typing import Iterable

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import user_repo
from backend.common.models.discussions import Person

FORMER_MEMBER = "Former member"


def _person(uid: str, ident: dict | None) -> Person:
    if ident is None:
        return Person(id=uid, display_name=FORMER_MEMBER, deleted=True)
    return Person(
        id=uid, display_name=ident["name"] or ident["email"] or FORMER_MEMBER,
        email=None if ident["deleted"] else ident["email"], avatar_id=ident["avatar_id"],
        has_image=ident["has_image"], deleted=ident["deleted"],
    )


async def people_map(session: AsyncSession, ids: Iterable[str]) -> dict[str, Person]:
    """Every id in ``ids`` as a :class:`Person`, in one read. An id that resolves to
    nobody is a former member."""
    wanted = sorted({i for i in ids if i})
    identities = await user_repo.get_identities_by_ids(session, wanted)
    return {uid: _person(uid, identities.get(uid)) for uid in wanted}
