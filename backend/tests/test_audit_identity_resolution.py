"""The audit log names the people in it.

Every row of the admin audit lens used to carry nothing but
``usr_ac3f19``-shaped strings under Actor and Target. An administrator
reading "who changed this person's role" had to open another tab per row to
find out who either party was — and once the account was deleted, there was
no way to find out at all.

Two rules these pin, and they pull against each other, which is the whole
reason they are written down:

  * a name IS resolved for a soft-deleted user, because "who was that
    account we removed, and what did it do first" is exactly the question
    an audit log exists to answer; and
  * a name is NEVER invented. An id that resolves to nothing stays a bare
    id — a system-generated event or a hard-deleted row is a real state,
    and "Unknown User" would claim a fact the database does not have.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import UserORM
from backend.app.db.repositories import user_repo


async def _seed(db_session, *, uid: str, first: str, last: str,
                email: str, display: str | None = None, deleted=None) -> str:
    db_session.add(UserORM(
        id=uid, email=email, password_hash="x",
        first_name=first, last_name=last, display_name=display,
        status="active", deleted_at=deleted,
    ))
    await db_session.flush()
    return uid


@pytest.mark.asyncio
async def test_the_log_says_who_the_actor_and_the_target_are(
    test_client: AsyncClient, db_session,
):
    await _seed(db_session, uid="usr_actor1", first="Ada", last="Lovelace",
                email="ada@example.com")
    await _seed(db_session, uid="usr_target1", first="John", last="Doe",
                email="john.doe@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"actor_id": "usr_actor1", "user_id": "usr_target1", "role": "admin"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    assert resp.status_code == 200, resp.text
    ev = next(e for e in resp.json()["events"] if e["eventType"] == "rbac.role.updated")

    # The ids remain — they are the record, and the client still needs them
    # to link onward and to show in the details panel.
    assert ev["actorId"] == "usr_actor1"
    assert ev["targetUserId"] == "usr_target1"
    # …and now they have people attached.
    assert ev["actorName"] == "Ada Lovelace"
    assert ev["actorEmail"] == "ada@example.com"
    assert ev["targetUserName"] == "John Doe"
    assert ev["targetUserEmail"] == "john.doe@example.com"
    assert ev["actorDeleted"] is False
    assert ev["targetUserDeleted"] is False


@pytest.mark.asyncio
async def test_a_stored_display_name_wins_over_a_rejoin_of_the_halves(
    test_client: AsyncClient, db_session,
):
    """Through the shared resolver, never `f"{first} {last}"`.

    Five surfaces once each re-joined the halves and disagreed with the
    stored name; the audit log must not become the sixth, or it names people
    differently from the user list it links to.
    """
    await _seed(db_session, uid="usr_disp", first="Jonathan", last="Doe",
                email="jd@example.com", display="JD from Platform")
    await user_repo.create_outbox_event(
        db_session, event_type="user.status_changed",
        payload={"user_id": "usr_disp", "status": "suspended"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(e for e in resp.json()["events"] if e["targetUserId"] == "usr_disp")
    assert ev["targetUserName"] == "JD from Platform"
    assert "Jonathan Doe" != ev["targetUserName"]


@pytest.mark.asyncio
async def test_a_deleted_user_is_still_named_and_marked_as_deleted(
    test_client: AsyncClient, db_session,
):
    """The most interesting row in an audit log is often a gone account."""
    from datetime import datetime, timezone
    await _seed(db_session, uid="usr_gone", first="Grace", last="Hopper",
                email="grace@example.com",
                deleted=datetime.now(timezone.utc).isoformat())
    await user_repo.create_outbox_event(
        db_session, event_type="user.deleted",
        payload={"user_id": "usr_gone", "actor_id": "usr_gone"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(e for e in resp.json()["events"] if e["targetUserId"] == "usr_gone")
    assert ev["targetUserName"] == "Grace Hopper", (
        "excluding soft-deleted users makes the log unable to answer the one "
        "question it exists for"
    )
    assert ev["targetUserEmail"] == "grace@example.com"
    assert ev["targetUserDeleted"] is True


@pytest.mark.asyncio
async def test_an_unresolvable_id_stays_a_bare_id_rather_than_becoming_a_name(
    test_client: AsyncClient, db_session,
):
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"actor_id": "usr_never_existed", "role": "admin"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(e for e in resp.json()["events"]
              if e["actorId"] == "usr_never_existed")
    assert ev["actorName"] is None
    assert ev["actorEmail"] is None
    assert ev["actorDeleted"] is False


@pytest.mark.asyncio
async def test_an_event_with_no_actor_at_all_resolves_to_nothing_quietly(
    test_client: AsyncClient, db_session,
):
    """Automated events have no actor; that must not error or invent one."""
    await user_repo.create_outbox_event(
        db_session, event_type="user.access_denied",
        payload={"user_id": None},
    )
    await db_session.commit()
    resp = await test_client.get("/api/v1/admin/audit?category=all")
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_the_page_is_resolved_in_one_query_however_many_rows_repeat_a_person(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """One lookup per PAGE, deduplicated — not one per row.

    An audit log is mostly the same few administrators over and over, so
    resolving per row would multiply a page into dozens of round trips for a
    handful of distinct people.
    """
    await _seed(db_session, uid="usr_busy", first="Busy", last="Admin",
                email="busy@example.com")
    for i in range(6):
        await user_repo.create_outbox_event(
            db_session, event_type="rbac.role.updated",
            payload={"actor_id": "usr_busy", "role": f"r{i}"},
        )
    await db_session.commit()

    calls: list[list[str]] = []
    real = user_repo.get_identities_by_ids

    async def spy(session, ids):
        calls.append(list(ids))
        return await real(session, ids)

    monkeypatch.setattr(user_repo, "get_identities_by_ids", spy)
    resp = await test_client.get("/api/v1/admin/audit?category=all")
    assert resp.status_code == 200, resp.text

    assert len(calls) == 1, f"resolved {len(calls)} times for one page"
    named = [e for e in resp.json()["events"] if e["actorId"] == "usr_busy"]
    assert len(named) >= 6
    assert all(e["actorName"] == "Busy Admin" for e in named)


@pytest.mark.asyncio
async def test_the_lens_still_renders_when_the_lookup_fails(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """The ids are the record; the names are an enrichment of it.

    A log that renders with raw ids is enormously more useful than one that
    500s, so a failure here degrades rather than propagates.
    """
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"actor_id": "usr_x", "role": "admin"},
    )
    await db_session.commit()

    async def boom(session, ids):
        raise RuntimeError("users table unavailable")

    monkeypatch.setattr(user_repo, "get_identities_by_ids", boom)
    resp = await test_client.get("/api/v1/admin/audit?category=all")
    assert resp.status_code == 200, resp.text
    ev = next(e for e in resp.json()["events"] if e["actorId"] == "usr_x")
    assert ev["actorName"] is None
