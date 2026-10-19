"""Asking to join a workspace, and answering.

A person has one open request per workspace — asking again returns the first,
and a unique index holds the rule when two asks race each other. A request
moves from pending to approved, denied or withdrawn, or to waiting on the
identity provider and from there to approved.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AccessRequestORM
from backend.app.db.repositories import access_request_repo


async def _ask(session: AsyncSession, who: str = "usr_ana", ws: str = "ws_fin", role: str = "workspace_viewer"):
    return await access_request_repo.create(
        session, requester_id=who, target_type="workspace", target_id=ws,
        requested_role=role, justification=" Joining the close team ",
    )


async def test_one_open_request_per_person_per_workspace(db_session: AsyncSession):
    first, created = await _ask(db_session)
    assert created and first.status == "pending" and first.justification == "Joining the close team"

    # Asking again — even for another role — returns the open request.
    again, created = await _ask(db_session, role="workspace_member")
    assert (again.id, created) == (first.id, False)

    # Another workspace, or another person, is another request.
    assert (await _ask(db_session, ws="ws_ops"))[1]
    assert (await _ask(db_session, who="usr_bob"))[1]

    # Once answered, the person may ask again.
    await access_request_repo.resolve(
        db_session, request_id=first.id, new_status="denied", resolver_id="usr_admin",
    )
    later, created = await _ask(db_session)
    assert created and later.id != first.id


async def test_two_asks_racing_end_with_one_request(db_session: AsyncSession, monkeypatch):
    first, _ = await _ask(db_session)

    # The second ask checks before the first is written, then inserts: the
    # unique index refuses it and it answers with the first instead.
    real = access_request_repo.find_open_for
    calls = {"n": 0}

    async def missed_once(session, **kw):
        calls["n"] += 1
        return None if calls["n"] == 1 else await real(session, **kw)

    monkeypatch.setattr(access_request_repo, "find_open_for", missed_once)
    raced, created = await _ask(db_session)
    assert (raced.id, created) == (first.id, False)

    rows = (await db_session.execute(select(AccessRequestORM))).scalars().all()
    assert [r.id for r in rows] == [first.id]


async def test_the_index_refuses_a_second_open_request(db_session: AsyncSession):
    await _ask(db_session)
    db_session.add(AccessRequestORM(
        requester_id="usr_ana", target_type="workspace", target_id="ws_fin",
        requested_role="workspace_member", status="pending",
    ))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_answers_follow_the_allowed_transitions(db_session: AsyncSession):
    row, _ = await _ask(db_session)

    routed = await access_request_repo.resolve(
        db_session, request_id=row.id, new_status="awaiting_idp", resolver_id="usr_admin",
        idp_group="finance-analysts",
    )
    assert (routed.status, routed.idp_group) == ("awaiting_idp", "finance-analysts")
    # Still open: no second request while it waits on the identity provider.
    assert (await _ask(db_session))[0].id == row.id
    # Pointing it to the identity provider again is not an answer it can take.
    with pytest.raises(ValueError):
        await access_request_repo.resolve(
            db_session, request_id=row.id, new_status="awaiting_idp", resolver_id="usr_admin",
            idp_group="other",
        )

    done = await access_request_repo.resolve(
        db_session, request_id=row.id, new_status="approved", resolver_id="usr_admin",
        granted_role="workspace_viewer", idp_group="finance-analysts",
    )
    assert (done.status, done.granted_role) == ("approved", "workspace_viewer")
    with pytest.raises(ValueError):
        await access_request_repo.resolve(
            db_session, request_id=row.id, new_status="withdrawn", resolver_id="usr_ana",
        )

    assert [r.id for r in await access_request_repo.list_for_requester(
        db_session, requester_id="usr_ana", status="open",
    )] == []
    with pytest.raises(ValueError):
        await access_request_repo.list_for_requester(db_session, requester_id="usr_ana", status="maybe")
