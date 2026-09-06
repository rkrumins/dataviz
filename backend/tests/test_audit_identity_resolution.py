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


@pytest.mark.asyncio
async def test_the_workspace_is_named_too(test_client: AsyncClient, db_session):
    """"ws_4f21c8" tells a reader nothing they can act on."""
    from backend.app.db.models import WorkspaceORM
    db_session.add(WorkspaceORM(id="ws_named", name="Data Platform"))
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.workspace.member_bound",
        payload={"workspace_id": "ws_named", "user_id": "usr_x", "role": "member"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(e for e in resp.json()["events"] if e["workspaceId"] == "ws_named")
    assert ev["workspaceName"] == "Data Platform"


@pytest.mark.asyncio
async def test_an_unknown_workspace_id_is_not_given_a_name(
    test_client: AsyncClient, db_session,
):
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.workspace.member_bound",
        payload={"workspace_id": "ws_gone", "user_id": "usr_x", "role": "member"},
    )
    await db_session.commit()
    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(e for e in resp.json()["events"] if e["workspaceId"] == "ws_gone")
    assert ev["workspaceName"] is None


@pytest.mark.asyncio
async def test_the_filter_takes_a_name_now_that_the_table_shows_names(
    test_client: AsyncClient, db_session,
):
    """Typing "john" must find John Doe's rows, not silently nothing."""
    await _seed(db_session, uid="usr_jd", first="John", last="Doe",
                email="john.doe@example.com")
    await _seed(db_session, uid="usr_ada", first="Ada", last="Lovelace",
                email="ada@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"user_id": "usr_jd", "role": "admin"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"user_id": "usr_ada", "role": "admin"},
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/audit?category=all&targetUserId=john")
    ids = {e["targetUserId"] for e in resp.json()["events"]}
    assert ids == {"usr_jd"}, ids


@pytest.mark.asyncio
async def test_the_filter_takes_an_email_too(test_client: AsyncClient, db_session):
    await _seed(db_session, uid="usr_jd2", first="John", last="Doe",
                email="john.doe@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"user_id": "usr_jd2", "role": "admin"},
    )
    await db_session.commit()
    resp = await test_client.get(
        "/api/v1/admin/audit?category=all&targetUserId=john.doe@example.com")
    assert {e["targetUserId"] for e in resp.json()["events"]} == {"usr_jd2"}


@pytest.mark.asyncio
async def test_an_exact_id_still_filters_exactly(test_client: AsyncClient, db_session):
    """Every existing link and bookmark passes an id; none may break."""
    await _seed(db_session, uid="usr_exact", first="Ex", last="Act",
                email="ex@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"user_id": "usr_exact", "role": "admin"},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"user_id": "usr_other_one", "role": "admin"},
    )
    await db_session.commit()
    resp = await test_client.get(
        "/api/v1/admin/audit?category=all&targetUserId=usr_exact")
    assert {e["targetUserId"] for e in resp.json()["events"]} == {"usr_exact"}


@pytest.mark.asyncio
async def test_an_id_that_names_nobody_still_filters_to_nothing(
    test_client: AsyncClient, db_session,
):
    """A term matching no user must not silently widen to everything.

    The dangerous failure here is the opposite of the obvious one: resolving
    the term to an empty set and then treating "empty" as "no filter" would
    show the operator every row they asked to exclude.
    """
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.role.updated",
        payload={"user_id": "usr_someone", "role": "admin"},
    )
    await db_session.commit()
    resp = await test_client.get(
        "/api/v1/admin/audit?category=all&targetUserId=nobody-by-that-name")
    assert resp.json()["events"] == []


# ── Everything else gets named too ───────────────────────────────────


@pytest.mark.asyncio
async def test_groups_providers_and_targets_are_named_in_summaries(
    test_client: AsyncClient, db_session,
):
    """``rbac.group`` / ``sso_mapping`` events used to print ``grp_`` /
    ``idp_`` ids in their one-line summaries. The reference pass swaps
    every known id for the thing's name — in the summary, and in
    ``resolvedNames`` for the payload drawer — while the raw payload
    keeps the ids, because the ids are the record."""
    from backend.app.db.repositories import group_repo, idp_provider_repo

    group = await group_repo.create_group(
        db_session, name="Use Case A", description="",
    )
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-ad", display_name="Corp AD",
        kind="oidc", settings={},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.group.member_added",
        payload={"actor_id": "usr_x", "user_id": "usr_y",
                 "group_id": group.id},
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.sso_mapping.updated",
        payload={
            "mapping_id": "map_1", "actor_id": "usr_x",
            "before": {
                "idp_group": "group1", "target_type": "group_membership",
                "target_group_id": group.id, "provider_id": provider.id,
            },
            "after": {
                "idp_group": "group1", "target_type": "role_binding",
                "role_name": "org_admin", "scope_type": "global",
                "scope_id": None, "provider_id": provider.id,
            },
        },
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    assert resp.status_code == 200, resp.text
    events = resp.json()["events"]

    member = next(
        e for e in events if e["eventType"] == "rbac.group.member_added"
    )
    assert "Use Case A" in member["summary"]
    assert group.id not in member["summary"]
    assert member["resolvedNames"][group.id] == "Use Case A"
    assert member["payload"]["group_id"] == group.id

    updated = next(
        e for e in events if e["eventType"] == "rbac.sso_mapping.updated"
    )
    assert "org_admin" in updated["summary"]
    # The was-clause names the old target rather than its id.
    assert "Use Case A" in updated["summary"]
    assert updated["resolvedNames"][group.id] == "Use Case A"
    assert updated["resolvedNames"][provider.id] == "Corp AD"


@pytest.mark.asyncio
async def test_an_unknown_reference_keeps_its_id(
    test_client: AsyncClient, db_session,
):
    """A hard-deleted group is a real state; the summary keeps the raw
    id rather than inventing a name."""
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.group.member_added",
        payload={"user_id": "usr_y", "group_id": "grp_gonehard"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(
        e for e in resp.json()["events"]
        if e["eventType"] == "rbac.group.member_added"
        and e["payload"].get("group_id") == "grp_gonehard"
    )
    assert "grp_gonehard" in ev["summary"]
    assert ev["resolvedNames"] == {}


@pytest.mark.asyncio
async def test_a_deleted_group_is_still_named(
    test_client: AsyncClient, db_session,
):
    """Soft-deleted groups keep their name in the log — an event in a
    group that has since been removed is among the rows the log exists
    to explain."""
    from sqlalchemy import update as sa_update

    from backend.app.db.models import GroupORM
    from backend.app.db.repositories import group_repo

    group = await group_repo.create_group(
        db_session, name="Retired Team", description="",
    )
    await db_session.execute(
        sa_update(GroupORM).where(GroupORM.id == group.id)
        .values(deleted_at="2026-01-01T00:00:00Z")
    )
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.group.member_removed",
        payload={"user_id": "usr_y", "group_id": group.id},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(
        e for e in resp.json()["events"]
        if e["eventType"] == "rbac.group.member_removed"
    )
    assert "Retired Team" in ev["summary"]


@pytest.mark.asyncio
async def test_a_person_named_off_the_actor_target_slots_is_resolved(
    test_client: AsyncClient, db_session,
):
    """A payload routinely names a THIRD person — a ``granted_by``, an
    inviter, a member — beyond the row's actor and target. That id used to
    render raw while every other kind beside it was named."""
    await _seed(db_session, uid="usr_grantor", first="Grace", last="Grant",
                email="grace@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.group.member_added",
        payload={"actor_id": "usr_sys", "user_id": "usr_member",
                 "granted_by": "usr_grantor", "group_id": "grp_x"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(
        e for e in resp.json()["events"]
        if e["payload"].get("granted_by") == "usr_grantor"
    )
    # The third party is named in the drawer map…
    assert ev["resolvedNames"]["usr_grantor"] == "Grace Grant"
    # …while the raw id is untouched in the payload — the id is the record.
    assert ev["payload"]["granted_by"] == "usr_grantor"
    # A person the directory does not know stays a bare id.
    assert "usr_member" not in ev["resolvedNames"]


@pytest.mark.asyncio
async def test_a_person_with_no_name_is_resolved_to_their_email(
    test_client: AsyncClient, db_session,
):
    """Name-or-email: an account that never set a name is still better
    named by its email than left as ``usr_…``."""
    await _seed(db_session, uid="usr_noname", first="", last="",
                email="only.email@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.group.member_added",
        payload={"user_id": "usr_target", "invited_by": "usr_noname",
                 "group_id": "grp_x"},
    )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=all")
    ev = next(
        e for e in resp.json()["events"]
        if e["payload"].get("invited_by") == "usr_noname"
    )
    assert ev["resolvedNames"]["usr_noname"] == "only.email@example.com"


@pytest.mark.asyncio
async def test_people_and_payload_refs_share_one_identity_query(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """The actor/target lookup and the payload-reference lookup are the
    SAME query — naming a third person must not double the page's identity
    round trips."""
    await _seed(db_session, uid="usr_a", first="Ann", last="Actor",
                email="ann@example.com")
    await _seed(db_session, uid="usr_g", first="Gil", last="Grantor",
                email="gil@example.com")
    await user_repo.create_outbox_event(
        db_session, event_type="rbac.group.member_added",
        payload={"actor_id": "usr_a", "user_id": "usr_t",
                 "granted_by": "usr_g", "group_id": "grp_x"},
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

    assert len(calls) == 1, f"resolved identities {len(calls)} times for one page"
    ev = next(
        e for e in resp.json()["events"]
        if e["payload"].get("granted_by") == "usr_g"
    )
    # Both the actor slot and the third-party ref came out of that one query.
    assert ev["actorName"] == "Ann Actor"
    assert ev["resolvedNames"]["usr_g"] == "Gil Grantor"
