"""Service accounts: principals that never sign in, whose keys answer to their managers.

A service account's keys work while it has a manager in good standing — a
person who could still sign in by the rule a personal key holds its owner to,
or a team with such a person in it — and for a grace period after its last one
goes, so an integration keeps running while someone appoints a successor. The
request path reads one stored fact, ``unmanaged_since``; the routes that change
managers and an hourly sweep keep it current, and tell the administrators.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql import Select

from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    IdpProviderORM,
    NotificationORM,
    RoleBindingORM,
    ServiceAccountManagerORM,
    ServiceAccountORM,
    UserIdentityORM,
    UserORM,
)
from backend.app.db.repositories import api_key_repo, role_repo, service_account_repo
from backend.app.services import api_key_housekeeping, permission_service, service_account_standing
from backend.auth_service.core import api_keys
from backend.auth_service.interface import InvalidCredentials
from backend.auth_service.service import LocalIdentityService
from tests.common.api_key_world import (
    OWNER,
    Key,
    api_key_app,
    days_ago,
    error,
    prime,
    user_row,
)
from tests.common.workspace_access_world import seed_org_reader_catalogue

NOW = datetime.now(timezone.utc)


def _ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


def _person(user_id: str, *, password: bool = True, status: str = "active") -> UserORM:
    return user_row(user_id, password=password, status=status)


def _account(user_id: str, *, status: str = "active", since: str | None = None):
    return [
        UserORM(
            id=user_id, email=f"{user_id}@service-account.invalid",
            password_hash="x-disabled-password-x", first_name=f"Account {user_id}",
            last_name="", status=status,
        ),
        ServiceAccountORM(user_id=user_id, unmanaged_since=since),
    ]


# ── Good standing ───────────────────────────────────────────────────


async def test_good_standing_in_sql_is_the_rule_a_personal_key_holds_its_owner_to(db_session):
    """One definition of "could still sign in": ``person_refusal`` in Python,
    and the SQL the standing of a service account's managers is judged by."""
    people = {
        "usr_pw": {}, "usr_nopw": {"password": False}, "usr_off": {"status": "suspended"},
        "usr_deleted": {}, "usr_sys": {}, "usr_sso_fresh": {"password": False},
        "usr_sso_stale": {}, "usr_sso_never": {"password": False},
    }
    rows = {}
    for uid, extra in people.items():
        rows[uid] = _person(uid, **extra)
        db_session.add(rows[uid])
    rows["usr_deleted"].deleted_at = _ago(1)
    rows["usr_sys"].is_system_account = True
    db_session.add(IdpProviderORM(
        id="idp_x", slug="x", display_name="X", kind="oidc", settings="{}", linking_policy="strict",
    ))
    last_login = {"usr_sso_fresh": _ago(1), "usr_sso_stale": _ago(40), "usr_sso_never": None}
    for uid, last in last_login.items():
        db_session.add(UserIdentityORM(
            user_id=uid, provider_id="idp_x", external_id=f"sub-{uid}", last_login_at=last,
        ))
    await db_session.flush()

    for window, passwords in ((30, True), (30, False), (None, True), (None, False)):
        standing = service_account_repo.in_good_standing(
            UserORM, now=NOW, window_days=window, passwords_allowed=passwords,
        )
        in_sql = dict((await db_session.execute(
            select(UserORM.id, standing).where(UserORM.id.in_(people))
        )).all())
        for uid in people:
            in_python = api_keys.person_refusal(
                rows[uid], identity_count=int(uid in last_login),
                idp_last_login_at=last_login.get(uid), now=NOW,
                sso_signin_window_days=window, passwords_allowed=passwords,
            ) is None
            assert bool(in_sql[uid]) == in_python, (uid, window, passwords)


async def test_an_account_is_managed_by_a_person_or_a_team_in_good_standing(db_session):
    for uid, extra in (("usr_ok", {}), ("usr_off", {"status": "suspended"}), ("usr_nopw", {"password": False})):
        db_session.add(_person(uid, **extra))
    db_session.add(GroupORM(id="grp_live", name="Live"))
    db_session.add(GroupORM(id="grp_stale", name="Stale"))
    db_session.add(GroupORM(id="grp_gone", name="Gone", deleted_at=_ago(1)))
    cases = {
        "svc_person": [("user", "usr_ok")],
        "svc_left": [("user", "usr_off")],
        "svc_team": [("group", "grp_live")],
        "svc_stale_team": [("group", "grp_stale")],
        "svc_gone_team": [("group", "grp_gone")],
        "svc_nobody": [],
        "svc_mixed": [("user", "usr_off"), ("group", "grp_live")],
    }
    for account in cases:
        db_session.add_all(_account(account))
    await db_session.flush()
    for gid, uid in (("grp_live", "usr_ok"), ("grp_stale", "usr_nopw"), ("grp_gone", "usr_ok")):
        db_session.add(GroupMemberORM(group_id=gid, user_id=uid))
    for account, managers in cases.items():
        for kind, subject in managers:
            db_session.add(ServiceAccountManagerORM(
                service_account_id=account,
                **({"user_id": subject} if kind == "user" else {"group_id": subject}),
            ))
    await db_session.flush()

    managed = service_account_repo.managed(
        ServiceAccountORM.user_id, now=NOW, window_days=30, passwords_allowed=True,
    )
    found = dict((await db_session.execute(
        select(ServiceAccountORM.user_id, managed)
    )).all())
    assert {a for a, ok in found.items() if ok} == {"svc_person", "svc_team", "svc_mixed"}


# ── Keeping unmanaged_since current, and telling the administrators ─


async def _platform_admin(db_session, user_id: str = "usr_admin") -> None:
    db_session.add(_person(user_id))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=user_id, role_name="super_admin",
        scope_type="global", scope_id=None,
    ))


async def _notes(db_session, kind: str) -> list[NotificationORM]:
    return list((await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == kind)
    )).scalars().all())


async def test_losing_the_last_manager_is_noticed_once_and_admins_are_told(db_session):
    await _platform_admin(db_session)
    db_session.add(_person("usr_mgr"))
    db_session.add_all(_account("svc_job"))
    await db_session.flush()
    db_session.add(ServiceAccountManagerORM(service_account_id="svc_job", user_id="usr_mgr"))
    await db_session.commit()

    rules = service_account_standing.Policy(window_days=30, passwords_allowed=True, grace_days=14)
    assert await service_account_standing.refresh(db_session, now=NOW, rules=rules) == []

    (await db_session.get(UserORM, "usr_mgr")).status = "suspended"
    await db_session.commit()
    assert await service_account_standing.refresh(db_session, now=NOW, rules=rules) == ["svc_job"]
    account = await db_session.get(ServiceAccountORM, "svc_job")
    assert account.unmanaged_since == NOW.isoformat()
    [note] = await _notes(db_session, "service_account_unmanaged")
    assert (note.user_id, note.resource_id) == ("usr_admin", "svc_job")
    assert (NOW + timedelta(days=14)).date().isoformat() in note.body

    # Noticed once: a later pass keeps the first stamp and tells nobody again.
    later = NOW + timedelta(hours=1)
    assert await service_account_standing.refresh(db_session, now=later, rules=rules) == []
    await db_session.refresh(account)
    assert account.unmanaged_since == NOW.isoformat()
    assert len(await _notes(db_session, "service_account_unmanaged")) == 1

    # A manager again clears it.
    (await db_session.get(UserORM, "usr_mgr")).status = "active"
    await db_session.commit()
    await service_account_standing.refresh(db_session, now=later, rules=rules)
    await db_session.refresh(account)
    assert account.unmanaged_since is None


async def test_admins_are_reminded_three_days_before_the_keys_pause(db_session):
    await _platform_admin(db_session)
    db_session.add_all(_account("svc_due", since=_ago(12)))
    db_session.add_all(_account("svc_later", since=_ago(5)))
    db_session.add_all(_account("svc_paused", since=_ago(20)))
    db_session.add_all(_account("svc_off", status="suspended", since=_ago(12)))
    await db_session.commit()

    rules = service_account_standing.Policy(window_days=30, passwords_allowed=True, grace_days=14)
    assert await service_account_standing.remind_pausing(db_session, now=NOW, rules=rules) == 2
    titles = {n.resource_id: n.title for n in await _notes(db_session, "service_account_pausing")}
    # One whose keys have paused already, never told — the sweep was down,
    # say — is told that.
    assert titles == {
        "svc_due": "A service account's keys pause soon",
        "svc_paused": "A service account's keys have paused",
    }
    assert (await db_session.get(ServiceAccountORM, "svc_due")).pause_reminded_at
    # Once per lapse.
    assert await service_account_standing.remind_pausing(db_session, now=NOW, rules=rules) == 0
    # With no grace there is nothing to warn of.
    instant = service_account_standing.Policy(window_days=30, passwords_allowed=True, grace_days=0)
    assert await service_account_standing.remind_pausing(db_session, now=NOW, rules=instant) == 0


async def test_a_reminder_follows_the_grace_period_when_it_changes(db_session):
    await _platform_admin(db_session)
    db_session.add_all(_account("svc_job", since=_ago(12)))
    db_session.add_all(_account("svc_new", since=_ago(12)))
    await db_session.commit()

    def grace(days: int):
        return service_account_standing.Policy(window_days=30, passwords_allowed=True, grace_days=days)

    async def told() -> list[tuple[str, str]]:
        return [(n.resource_id, n.title) for n in await _notes(db_session, "service_account_pausing")]

    # Reminded under 14 days, of the pause two days out — svc_new too.
    assert await service_account_standing.remind_pausing(db_session, now=NOW, rules=grace(14)) == 2
    # Lengthened to 30: nothing is due until the new day draws near, then it is.
    assert await service_account_standing.remind_pausing(db_session, now=NOW, rules=grace(30)) == 0
    later = NOW + timedelta(days=16)
    assert await service_account_standing.remind_pausing(db_session, now=later, rules=grace(30)) == 2
    assert (await told())[2:] == [
        ("svc_job", "A service account's keys pause soon"), ("svc_new", "A service account's keys pause soon"),
    ]
    assert (NOW + timedelta(days=18)).date().isoformat() in (await _notes(db_session, "service_account_pausing"))[2].body

    # Shortened past it: the keys have paused, and the administrators hear so, once.
    (await db_session.get(ServiceAccountORM, "svc_new")).pause_reminded_at = None
    await db_session.commit()
    assert await service_account_standing.remind_pausing(db_session, now=later, rules=grace(10)) == 1
    assert (await told())[4:] == [("svc_new", "A service account's keys have paused")]
    assert await service_account_standing.remind_pausing(db_session, now=later, rules=grace(10)) == 0


async def test_many_accounts_at_once_are_one_notice_for_the_administrators(db_session):
    """A sign-in window shortened, or someone who managed a dozen accounts
    suspended: one notice each for the lapse and the reminder, not a dozen."""
    await _platform_admin(db_session)
    db_session.add(_person("usr_mgr"))
    accounts = [f"svc_{n}" for n in range(6)]
    for account in accounts:
        db_session.add_all(_account(account))
    await db_session.flush()
    for account in accounts:
        db_session.add(ServiceAccountManagerORM(service_account_id=account, user_id="usr_mgr"))
    (await db_session.get(UserORM, "usr_mgr")).status = "suspended"
    await db_session.commit()

    rules = service_account_standing.Policy(window_days=30, passwords_allowed=True, grace_days=14)
    assert await service_account_standing.refresh(db_session, now=NOW, rules=rules) == accounts
    [note] = await _notes(db_session, "service_account_unmanaged")
    assert note.title == "6 service accounts have no manager left"
    assert "“Account svc_0”, “Account svc_1”, “Account svc_2” and 3 more" in note.body
    assert (NOW + timedelta(days=14)).date().isoformat() in note.body

    later = NOW + timedelta(days=12)
    assert await service_account_standing.remind_pausing(db_session, now=later, rules=rules) == 6
    [reminder] = await _notes(db_session, "service_account_pausing")
    assert reminder.title == "6 service accounts still have no manager"
    assert await service_account_standing.remind_pausing(db_session, now=later, rules=rules) == 0


async def test_standing_is_read_only_once_the_accounts_are_locked(db_session, monkeypatch):
    """Two refreshes at once — a route's and the sweep's — must not stamp an
    account from a list of managers the other has just changed: each locks
    the rows, in one order, before it reads who manages them."""
    db_session.add_all(_account("svc_b") + _account("svc_a"))
    await db_session.commit()
    seen = []
    execute = db_session.execute

    async def _recording(statement, *args, **kwargs):
        seen.append(statement)
        return await execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, "execute", _recording)
    await service_account_repo.refresh_standing(
        db_session, now=NOW, window_days=30, passwords_allowed=True, account_ids=["svc_b", "svc_a"],
    )
    lock, read = seen[0], seen[1]
    assert isinstance(lock, Select) and lock._for_update_arg is not None
    assert "ORDER BY service_accounts.user_id" in str(lock)
    assert isinstance(read, Select) and read._for_update_arg is None


async def test_the_sweep_locks_only_the_accounts_whose_standing_changed(db_session, monkeypatch):
    """The hourly pass reads every account's standing without locking any,
    and locks — skipping any a request holds, which settles them itself —
    only those it is about to stamp or clear. A deleted account is left as it
    is until it is restored."""
    db_session.add(_person("usr_ok"))
    db_session.add_all(_account("svc_ok") + _account("svc_lost") + _account("svc_back", since=_ago(2)))
    db_session.add_all(_account("svc_gone"))
    await db_session.flush()
    for account in ("svc_ok", "svc_back"):
        db_session.add(ServiceAccountManagerORM(service_account_id=account, user_id="usr_ok"))
    (await db_session.get(UserORM, "svc_gone")).deleted_at = _ago(1)
    await db_session.commit()
    seen, settled = [], []
    execute, settle = db_session.execute, service_account_repo._settle

    async def _recording(statement, *args, **kwargs):
        seen.append(statement)
        return await execute(statement, *args, **kwargs)

    async def _settling(session, account_ids, **rules):
        settled.append(account_ids)
        return await settle(session, account_ids, **rules)

    monkeypatch.setattr(db_session, "execute", _recording)
    monkeypatch.setattr(service_account_repo, "_settle", _settling)
    lost = await service_account_repo.refresh_standing(
        db_session, now=NOW, window_days=30, passwords_allowed=True,
    )
    monkeypatch.undo()
    assert lost == ["svc_lost"]
    assert settled == [["svc_back", "svc_lost"]]
    lock = seen[0]
    assert isinstance(lock, Select) and lock._for_update_arg.skip_locked
    assert "FOR UPDATE OF service_accounts SKIP LOCKED" in str(lock.compile(dialect=postgresql.dialect()))
    standing = {
        row.user_id: row.unmanaged_since
        for row in (await db_session.execute(select(ServiceAccountORM))).scalars()
    }
    assert standing["svc_ok"] is None and standing["svc_back"] is None
    assert standing["svc_lost"] == NOW.isoformat()
    assert standing["svc_gone"] is None
    # Nor does a change to who manages it — a team's, say — stamp it.
    assert await service_account_repo.refresh_standing(
        db_session, now=NOW, window_days=30, passwords_allowed=True, account_ids=["svc_gone"],
    ) == []
    assert (await db_session.get(ServiceAccountORM, "svc_gone")).unmanaged_since is None


async def test_the_sweep_settles_every_account_a_batch_at_a_time(db_session, monkeypatch):
    monkeypatch.setattr(service_account_repo, "_BATCH", 2)
    accounts = [f"svc_{i}" for i in range(5)]
    for account in accounts:
        db_session.add_all(_account(account))
    await db_session.commit()
    assert await service_account_repo.refresh_standing(
        db_session, now=NOW, window_days=30, passwords_allowed=True,
    ) == accounts
    assert {
        row.unmanaged_since for row in (await db_session.execute(select(ServiceAccountORM))).scalars()
    } == {NOW.isoformat()}


async def test_the_hourly_pass_checks_standing_first_and_a_failing_step_stops_nothing(
    db_session, monkeypatch,
):
    shutdown = asyncio.Event()
    ran, counted = [], []

    async def _standing_fails(_session, **_kw):
        ran.append("service_accounts")
        raise RuntimeError("the database went away")

    async def _reminders(_session):
        ran.append("expiry_reminders")
        return 0

    async def _purge(_session):
        ran.append("service_account_purge")
        return 0

    async def _prune(_session):
        ran.append("usage_prune")
        shutdown.set()
        return 0

    @asynccontextmanager
    async def _transaction():
        try:
            yield db_session
            await db_session.commit()
        except BaseException:
            await db_session.rollback()
            raise

    monkeypatch.setattr(service_account_standing, "sweep", _standing_fails)
    monkeypatch.setattr(api_key_housekeeping, "remind_once", _reminders)
    monkeypatch.setattr(api_key_housekeeping, "purge_deleted", _purge)
    monkeypatch.setattr(api_key_housekeeping.api_key_usage_repo, "prune", _prune)
    monkeypatch.setattr(
        api_key_housekeeping, "metrics_increment",
        lambda name, value=1.0, **labels: counted.append((name, labels["step"], labels["outcome"])),
    )
    await asyncio.wait_for(
        api_key_housekeeping.run_sweeper(_transaction, shutdown, interval=3600), timeout=10,
    )
    assert ran == ["service_accounts", "expiry_reminders", "service_account_purge", "usage_prune"]
    assert counted == [
        ("api_key_housekeeping_steps_total", "service_accounts", "failed"),
        ("api_key_housekeeping_steps_total", "expiry_reminders", "done"),
        ("api_key_housekeeping_steps_total", "service_account_purge", "done"),
        ("api_key_housekeeping_steps_total", "usage_prune", "done"),
    ]


async def test_with_no_grace_the_admins_hear_the_keys_are_paused(db_session):
    await _platform_admin(db_session)
    db_session.add_all(_account("svc_job"))
    await db_session.commit()
    rules = service_account_standing.Policy(window_days=30, passwords_allowed=True, grace_days=0)
    assert await service_account_standing.refresh(db_session, now=NOW, rules=rules) == ["svc_job"]
    [note] = await _notes(db_session, "service_account_unmanaged")
    assert "paused" in note.body


async def test_the_hourly_sweep_reads_the_switches_a_key_request_reads(db_session):
    """A manager whose sign-in window lapses is noticed by the sweep, with the
    window and the grace the administrator chose."""
    await _platform_admin(db_session)
    db_session.add(_person("usr_sso", password=False))
    db_session.add(IdpProviderORM(
        id="idp_x", slug="x", display_name="X", kind="oidc", settings="{}", linking_policy="strict",
    ))
    db_session.add_all(_account("svc_job"))
    await db_session.flush()
    db_session.add(UserIdentityORM(
        user_id="usr_sso", provider_id="idp_x", external_id="sub", last_login_at=_ago(20),
    ))
    db_session.add(ServiceAccountManagerORM(service_account_id="svc_job", user_id="usr_sso"))
    await db_session.commit()

    prime(apiKeySsoSignInWindow="30")
    assert await service_account_standing.sweep(db_session, now=NOW) == (0, 0)
    prime(apiKeySsoSignInWindow="14", serviceAccountUnmanagedGrace="7")
    try:
        assert await service_account_standing.sweep(db_session, now=NOW) == (1, 0)
    finally:
        prime(apiKeySsoSignInWindow="30", serviceAccountUnmanagedGrace="14")
    [note] = await _notes(db_session, "service_account_unmanaged")
    assert (NOW + timedelta(days=7)).date().isoformat() in note.body


# ── On the wire ─────────────────────────────────────────────────────


@pytest.fixture()
async def client(db_session, monkeypatch):
    async with api_key_app(db_session, monkeypatch) as http:
        yield http


async def _service_key(db_session, account: str = "svc_job") -> Key:
    generated = api_keys.generate(api_keys.KIND_SERVICE)
    row = await api_key_repo.create(
        db_session, user_id=account, kind="service", created_by=OWNER, name="sync",
        description=None, token_prefix=generated.display_prefix,
        token_hash=generated.token_hash,
        permissions={"views": "read", "data": "read", "publish": False},
        resources="all", allowed_cidrs=None, expires_at=None,
        created_ip=None, created_user_agent=None,
    )
    await db_session.commit()
    return Key(id=row.id, token=generated.token)


async def _managed_account(db_session, account: str = "svc_job") -> None:
    """A service account a person manages, a viewer in ws_a."""
    db_session.add_all(_account(account))
    await db_session.flush()
    db_session.add(ServiceAccountManagerORM(service_account_id=account, user_id=OWNER))
    db_session.add(RoleBindingORM(
        subject_type="user", subject_id=account, role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_a",
    ))
    await db_session.commit()


async def test_a_service_accounts_key_works_through_the_grace_and_then_pauses(client, db_session):
    await _managed_account(db_session)
    key = await _service_key(db_session)
    assert key.token.startswith("nxsat_")
    ok = await client.get("/api/v1/views/v_a_ws", headers=key.headers)
    assert ok.status_code == 200, ok.text

    account = await db_session.get(ServiceAccountORM, "svc_job")
    account.unmanaged_since = days_ago(10)
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200

    account.unmanaged_since = days_ago(20)
    await db_session.commit()
    refused = await client.get("/api/v1/views/v_a_ws", headers=key.headers)
    assert (refused.status_code, error(refused)) == (401, "api_key_unmanaged")
    described = await client.get("/api/v1/api-keys/self", headers=key.headers)
    assert described.status_code == 200
    assert (described.json()["kind"], described.json()["status"]) == ("service", "paused")

    # The period is the administrator's to choose.
    prime(serviceAccountUnmanagedGrace="30")
    try:
        assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200
    finally:
        prime(serviceAccountUnmanagedGrace="14")

    # A manager again, and it works at once.
    account.unmanaged_since = None
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200


async def test_a_disabled_service_accounts_keys_stop_at_once(client, db_session):
    await _managed_account(db_session)
    key = await _service_key(db_session)
    (await db_session.get(UserORM, "svc_job")).status = "suspended"
    await db_session.commit()
    refused = await client.get("/api/v1/views/v_a_ws", headers=key.headers)
    assert (refused.status_code, error(refused)) == (401, "api_key_owner_inactive")


async def test_a_deleted_service_accounts_keys_stop_at_once_and_work_again_restored(client, db_session):
    await _managed_account(db_session)
    key = await _service_key(db_session)
    account = await db_session.get(UserORM, "svc_job")
    account.deleted_at = days_ago(1)
    await db_session.commit()
    refused = await client.get("/api/v1/views/v_a_ws", headers=key.headers)
    assert (refused.status_code, error(refused)) == (401, "api_key_owner_inactive")
    account.deleted_at = None
    await db_session.commit()
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200


async def test_a_service_accounts_keys_stop_when_its_record_is_gone(client, db_session):
    """A rollback of the service account tables leaves the account's user row
    and keys behind with nobody answering for them: they are refused."""
    await _managed_account(db_session)
    key = await _service_key(db_session)
    assert (await client.get("/api/v1/views/v_a_ws", headers=key.headers)).status_code == 200
    await db_session.delete(await db_session.get(ServiceAccountORM, "svc_job"))
    await db_session.commit()
    refused = await client.get("/api/v1/views/v_a_ws", headers=key.headers)
    assert (refused.status_code, error(refused)) == (401, "api_key_owner_inactive")


async def test_a_service_account_acts_only_through_its_own_roles(db_session):
    """A team's role attached to a service account never reaches its keys,
    and of a platform role only reading every workspace does."""
    await seed_org_reader_catalogue(db_session)
    db_session.add_all(_account("svc_claims"))
    db_session.add(_person("usr_twin"))
    db_session.add(GroupORM(id="grp_x", name="X"))
    await db_session.flush()
    for subject in ("svc_claims", "usr_twin"):
        db_session.add(GroupMemberORM(group_id="grp_x", user_id=subject))
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=subject, role_name="workspace_viewer",
            scope_type="workspace", scope_id="ws_a",
        ))
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=subject, role_name="super_admin",
            scope_type="global", scope_id=None,
        ))
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id="grp_x", role_name="workspace_admin",
        scope_type="workspace", scope_id="ws_b",
    ))
    await db_session.commit()

    account = await permission_service.resolve(db_session, "svc_claims")
    person = await permission_service.resolve(db_session, "usr_twin")
    assert account.global_perms == ("system:org-viewer",)
    assert permission_service.has_permission(account, "workspace:view:read", workspace_id="ws_b")
    assert not permission_service.has_permission(account, "workspace:view:edit", workspace_id="ws_b")
    assert set(account.ws_perms) == {"ws_a"}
    assert person.global_perms and set(person.ws_perms) == {"ws_a", "ws_b"}


async def test_reading_every_workspace_reaches_its_keys_only_to_read(db_session):
    """``org_reader`` lets an account's keys read every workspace — one made
    later too — and change nothing there. Org Auditor gives it no more: not
    the audit log, the bindings or the analytics."""
    await seed_org_reader_catalogue(db_session)
    for account_id, role in (("svc_reader", "org_reader"), ("svc_auditor", "org_auditor")):
        db_session.add_all(_account(account_id))
        await db_session.flush()
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=account_id, role_name=role,
            scope_type="global", scope_id=None,
        ))
    await db_session.commit()
    for account_id in ("svc_reader", "svc_auditor"):
        resolved = await permission_service.resolve(db_session, account_id)
        assert resolved.global_perms == ("system:org-viewer",), account_id

    scope = permission_service.KeyScope(
        key_id="apk_reader", kind="service", views="write", data="write", all_resources=True,
    )
    keyed = await permission_service.resolve_for_api_key(db_session, "svc_reader", scope)
    assert keyed.global_perms == ()
    for permission in ("workspace:view:read", "workspace:datasource:read"):
        assert permission_service.has_permission(keyed, permission, workspace_id="ws_later"), permission
    for permission in ("workspace:view:edit", "workspace:datasource:manage"):
        assert not permission_service.has_permission(keyed, permission, workspace_id="ws_later"), permission


async def test_a_view_it_made_is_no_way_back_into_a_workspace(db_session):
    """A view a service account made through its key is its own only while it
    still holds a role in that workspace; a person keeps what they made."""
    from sqlalchemy import select as sql_select

    from backend.app.db.models import ViewORM
    from backend.app.services import view_access
    from backend.app.services.permission_service import PermissionClaims

    db_session.add_all([
        ViewORM(id="v_svc", name="Its own", workspace_id="ws_a", visibility="private", created_by="svc_maker"),
        ViewORM(id="v_usr", name="Theirs", workspace_id="ws_a", visibility="private", created_by="usr_maker"),
    ])
    await db_session.flush()

    def viewer(user_id, ws_perms):
        claims = PermissionClaims(sid="sess", global_perms=(), ws_perms=ws_perms)
        return view_access.ViewerContext(user_id=user_id, claims=claims, group_ids=())

    async def lists(ctx):
        scope = await view_access.build_read_scope(db_session, ctx)
        return set((await db_session.execute(
            sql_select(ViewORM.id).where(view_access.readable_views_clause(scope))
        )).scalars())

    holding = viewer("svc_maker", {"ws_a": ("workspace:datasource:read",)})
    gone = viewer("svc_maker", {})
    v_svc = await db_session.get(ViewORM, "v_svc")
    assert await view_access.can_read_view(db_session, holding, v_svc)
    assert await view_access.can_edit_view(db_session, holding, v_svc)
    assert "v_svc" in await lists(holding)
    assert not await view_access.can_read_view(db_session, gone, v_svc)
    assert not await view_access.can_edit_view(db_session, gone, v_svc)
    assert "v_svc" not in await lists(gone)

    person = viewer("usr_maker", {})
    assert await view_access.can_read_view(db_session, person, await db_session.get(ViewORM, "v_usr"))
    assert "v_usr" in await lists(person)


async def test_a_role_widened_after_it_was_given_brings_the_account_none_of_it(db_session):
    """A role it holds may later be given the power to administer a workspace;
    the account's keys never get that, though a person holding it does."""
    db_session.add_all(_account("svc_wide"))
    db_session.add(_person("usr_peer"))
    await db_session.flush()
    for subject in ("svc_wide", "usr_peer"):
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=subject, role_name="workspace_viewer",
            scope_type="workspace", scope_id="ws_a",
        ))
    await db_session.commit()
    before = await permission_service.resolve(db_session, "svc_wide")

    viewer = (await role_repo.role_names_with_permissions(db_session, ["workspace_viewer"]))
    await role_repo.update_role(
        db_session, "workspace_viewer",
        permissions=[*viewer["workspace_viewer"], "workspace:admin"],
    )
    await db_session.commit()

    account = await permission_service.resolve(db_session, "svc_wide")
    person = await permission_service.resolve(db_session, "usr_peer")
    assert account.ws_perms == before.ws_perms
    assert not permission_service.has_permission(account, "workspace:admin", workspace_id="ws_a")
    assert permission_service.has_permission(person, "workspace:admin", workspace_id="ws_a")


async def test_a_large_team_is_not_paged_about_every_key(db_session):
    """An account's notices go to its direct managers and whoever made the
    key; to a few of its team, the most recently active, when nobody closer
    can act; and to its administrators when nobody can."""
    db_session.add_all(_account("svc_aud"))
    db_session.add_all([_person("usr_direct"), _person("usr_root"), _person("usr_stranger")])
    db_session.add(GroupORM(id="grp_big", name="Everyone"))
    members = [f"usr_m{i:02d}" for i in range(30)]
    for i, uid in enumerate(members):
        row = _person(uid)
        row.last_active_at = _ago(30 - i)
        db_session.add(row)
    await db_session.flush()
    db_session.add_all([GroupMemberORM(group_id="grp_big", user_id=uid) for uid in members])
    db_session.add_all([
        ServiceAccountManagerORM(service_account_id="svc_aud", user_id="usr_direct"),
        ServiceAccountManagerORM(service_account_id="svc_aud", group_id="grp_big"),
        RoleBindingORM(
            subject_type="user", subject_id="usr_root", role_name="super_admin",
            scope_type="global", scope_id=None,
        ),
    ])
    await db_session.commit()

    async def told(maker=None):
        return (await service_account_standing.key_audience(db_session, "svc_aud", maker=maker)).user_ids

    assert await told() == {"usr_direct"}
    assert await told("usr_m03") == {"usr_direct", "usr_m03"}
    assert await told("usr_stranger") == {"usr_direct"}

    (await db_session.get(UserORM, "usr_direct")).status = "suspended"
    await db_session.commit()
    assert await told() == set(members[-25:])

    for uid in members:
        (await db_session.get(UserORM, uid)).status = "suspended"
    await db_session.commit()
    assert await told() == {"usr_root"}


# ── Never a session ─────────────────────────────────────────────────


async def test_nothing_signs_in_as_a_service_account():
    """Every way of signing in mints its session through one method, and
    that refuses a service account before anything else."""
    with pytest.raises(InvalidCredentials):
        await LocalIdentityService._mint_recorded_refresh(
            SimpleNamespace(), None, user_id="svc_job", family_id=None, auth_time=None,
        )


def test_no_identity_provider_links_to_a_service_account():
    existing = SimpleNamespace(id="svc_job", status="active", deleted_at=None)
    reasons = LocalIdentityService._link_deny_reasons(
        existing, linking_policy="auto", email_verified=True, has_existing_identity=False,
    )
    assert "service_account" in reasons
    person = SimpleNamespace(id="usr_x", status="active", deleted_at=None)
    assert "service_account" not in LocalIdentityService._link_deny_reasons(
        person, linking_policy="auto", email_verified=True, has_existing_identity=False,
    )


def test_the_grace_switch_reads_as_days():
    from backend.common.service_accounts import grace_days

    assert [grace_days(v) for v in ("0", "7", "14", "30")] == [0, 7, 14, 30]
    assert grace_days("nonsense") == grace_days(None) == grace_days("-3") == 14
