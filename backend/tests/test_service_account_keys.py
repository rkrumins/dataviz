"""A service account's keys: made by its managers, acting as the account.

The routes a person uses for their own keys serve a service account's under
``/me/service-accounts/{id}/api-keys``. Its managers — people, or members of a
team that manages it — and anyone holding ``system:users:manage`` reach them;
to everyone else the account does not exist. Whoever mints proves it is them
and is recorded as having done it, while the key acts as the account: it
reaches what the account reaches, counts against the account's limit, and its
notices go to the people who answer for the account.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.v1.endpoints import api_keys as api_keys_endpoints
from backend.app.api.v1.endpoints import versioning as versioning_endpoints
from backend.app.auth import dependencies
from backend.app.db.models import (
    ApiKeyORM,
    GroupMemberORM,
    GroupORM,
    NotificationORM,
    OutboxEventORM,
    RoleBindingORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.db.repositories import api_key_repo, service_account_repo
from backend.app.services import api_key_housekeeping, service_account_standing
from backend.auth_service.cookies import ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME
from backend.auth_service.core import api_keys
from backend.auth_service.core.password import hash_password
from backend.auth_service.core.tokens import create_access_token
from backend.auth_service.csrf import CSRF_HEADER_NAME, mint_csrf_token
from tests.common.api_key_world import (
    OTHER,
    OWNER,
    Key,
    _FakeVersioning,
    api_key_app,
    days_ago,
    error,
    mint,
    user_row,
)

PASSWORD = "correct horse battery staple"
#: A super admin: may make any account's keys without managing it.
ROOT = "usr_keyroot"
#: An org admin: looks after service accounts, but makes no keys for them.
ORG = "usr_keyorg"
_ROOT_PERMS = ("system:admin", "system:users:manage", "system:service-accounts:manage")
_ORG_PERMS = ("system:org-admin", "system:service-accounts:manage")


@pytest.fixture()
async def client(db_session, monkeypatch):
    async def _no_workspace_grants(_user_id):
        return {}

    # A session here is judged on its global permissions alone. Its workspace
    # grants would be read from the app's own pool — outside this test's
    # session, and outliving its event loop.
    monkeypatch.setattr(dependencies, "_workspace_grants_from_db", _no_workspace_grants)
    api_keys_endpoints.limiter.reset()
    async with api_key_app(db_session, monkeypatch) as http:
        db_session.add_all([user_row(ROOT), user_row(ORG)])
        for uid in (OWNER, OTHER, ROOT, ORG):
            await db_session.flush()
            (await db_session.get(UserORM, uid)).password_hash = hash_password(PASSWORD)
        # The platform's administrators, who hear about an account nobody answers for.
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=ROOT, role_name="super_admin",
            scope_type="global", scope_id=None,
        ))
        await db_session.commit()
        yield http
    api_keys_endpoints.limiter.reset()


@pytest.fixture()
async def account(client, db_session) -> str:
    """"Metadata sync", managed by the owner: a viewer in ws_a — where the
    owner is a member — and in ws_c, where the owner has nothing; nothing in
    ws_b, where the owner is a viewer."""
    account_id = await service_account_repo.create(
        db_session, name="Metadata sync", description=None, created_by=ROOT,
    )
    await service_account_repo.add_manager(db_session, account_id, user_id=OWNER, added_by=ROOT)
    db_session.add(WorkspaceORM(id="ws_c", name="ws_c"))
    await db_session.flush()
    for ws in ("ws_a", "ws_c"):
        db_session.add(RoleBindingORM(
            subject_type="user", subject_id=account_id, role_name="workspace_viewer",
            scope_type="workspace", scope_id=ws,
        ))
    await db_session.commit()
    return account_id


def _sign_in(client, user_id: str = OWNER, *, global_perms: tuple[str, ...] = ()) -> dict:
    """A password session for ``user_id``: its cookies on the client, and the
    CSRF header its writes carry."""
    sid = f"sess_{user_id}"
    extra = {"sid": sid, "signin": "password"}
    if global_perms:
        extra["global"] = list(global_perms)
    client.cookies.set(ACCESS_COOKIE_NAME, create_access_token(
        user_id=user_id, email=f"{user_id}@example.com", role="workspace_member", extra=extra,
    ))
    csrf = mint_csrf_token(sid)
    client.cookies.set(CSRF_COOKIE_NAME, csrf)
    return {CSRF_HEADER_NAME: csrf}


def _keys(account_id: str) -> str:
    return f"/api/v1/me/service-accounts/{account_id}/api-keys"


def _in(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _body(**overrides) -> dict:
    body = {
        "name": "nightly sync",
        "permissions": {"views": "read", "data": "read"},
        "resources": "all",
        "expiresAt": _in(30),
        "currentPassword": PASSWORD,
    }
    body.update(overrides)
    return body


async def _create(client, account_id, headers, **overrides):
    return await client.post(_keys(account_id), json=_body(**overrides), headers=headers)


async def _minted(session, account_id: str, **fields) -> Key:
    """A key for the account, written as the routes write one."""
    generated = api_keys.generate(api_keys.KIND_SERVICE)
    values = dict(
        user_id=account_id, kind=api_keys.KIND_SERVICE, created_by=OWNER, name="ci key",
        description=None, token_prefix=generated.display_prefix,
        token_hash=generated.token_hash,
        permissions={"views": "read", "data": "read", "publish": False},
        resources="all", allowed_cidrs=None, expires_at=None,
        created_ip=None, created_user_agent=None,
    )
    values.update(fields)
    row = await api_key_repo.create(session, **values)
    await session.commit()
    return Key(id=row.id, token=generated.token)


async def _notes(session, kind: str) -> list[NotificationORM]:
    return list((await session.execute(
        select(NotificationORM).where(NotificationORM.kind == kind).order_by(NotificationORM.user_id)
    )).scalars().all())


# ── Who may ─────────────────────────────────────────────────────────


async def test_a_super_admin_makes_no_key_while_their_session_cant_be_confirmed(
    client, db_session, account, monkeypatch,
):
    async def unconfirmed(*_args, **_kwargs):
        raise HTTPException(status_code=503, detail="Session state unavailable")

    monkeypatch.setattr(api_keys_endpoints, "assert_session_alive_or_503", unconfirmed)
    headers = _sign_in(client, ROOT, global_perms=_ROOT_PERMS)
    assert (await _create(client, account, headers)).status_code == 503
    # A manager acts by managing it, not by a power over every account.
    assert (await _create(client, account, _sign_in(client))).status_code == 201


async def test_who_acts_is_checked_again_once_they_have_proved_it(client, db_session, account):
    """Proving it's them may wait on a sign-in; meanwhile the manager may be
    removed or the account disabled."""
    owner = await db_session.get(UserORM, OWNER)
    principal = api_keys_endpoints._Principal(actor=owner, account=(await service_account_repo.get(db_session, account))[0])
    await api_keys_endpoints._still_acting(db_session, principal)

    await service_account_repo.remove_manager(db_session, account, user_id=OWNER)
    with pytest.raises(HTTPException) as removed:
        await api_keys_endpoints._still_acting(db_session, principal)
    assert removed.value.status_code == 404

    await service_account_repo.add_manager(db_session, account, user_id=OWNER, added_by=ROOT)
    (await db_session.get(UserORM, account)).status = "suspended"
    await db_session.commit()
    with pytest.raises(HTTPException) as disabled:
        await api_keys_endpoints._still_acting(db_session, principal)
    assert disabled.value.status_code == 409


async def test_a_key_that_revokes_itself_is_heard_of(client, db_session, account):
    key = await _minted(db_session, account)
    gone = await client.delete("/api/v1/api-keys/self", headers={"Authorization": f"Bearer {key.token}"})
    assert gone.status_code == 204, gone.text
    assert [n.user_id for n in await _notes(db_session, "api_key_revoked_itself")] == [OWNER]


async def test_nobody_approves_what_they_opened_through_an_account_they_manage(client, db_session, account):
    from backend.app.api.v1.endpoints import versioning

    with pytest.raises(HTTPException) as refused:
        await versioning._not_their_own(db_session, {"actor": account}, OWNER)
    assert refused.value.status_code == 403
    await versioning._not_their_own(db_session, {"actor": account}, OTHER)
    await versioning._not_their_own(db_session, {"actor": OTHER}, OWNER)



async def test_a_manager_makes_a_key_that_acts_as_the_account(client, db_session, account):
    headers = _sign_in(client)
    created = await _create(client, account, headers)
    assert created.status_code == 201, created.text
    assert created.headers["cache-control"] == "no-store"
    token, key = created.json()["token"], created.json()["key"]
    assert token.startswith("nxsat_") and key["kind"] == "service" and key["status"] == "active"

    row = await db_session.get(ApiKeyORM, key["id"])
    assert (row.user_id, row.kind, row.created_by) == (account, "service", OWNER)
    [event] = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "identity.api_key.created")
    )).scalars().all()
    assert event.aggregate_id == account
    assert json.loads(event.payload)["created_by"] == OWNER
    # A manager making the account's keys is what managing it means: nobody
    # needs telling.
    assert await _notes(db_session, "service_account_key_created") == []

    client.cookies.clear()
    used = await client.get("/api/v1/views/v_a_ws", headers={"Authorization": f"Bearer {token}"})
    assert used.status_code == 200, used.text
    itself = await client.get("/api/v1/api-keys/self", headers={"Authorization": f"Bearer {token}"})
    assert itself.json()["kind"] == "service" and itself.json()["userId"] == account


async def test_a_member_of_a_managing_team_makes_its_keys(client, db_session, account):
    db_session.add(GroupORM(id="grp_data", name="Data platform"))
    await db_session.flush()
    db_session.add(GroupMemberORM(group_id="grp_data", user_id=OTHER))
    await db_session.commit()
    headers = _sign_in(client, OTHER)
    assert (await client.get(_keys(account))).status_code == 404

    await service_account_repo.add_manager(db_session, account, group_id="grp_data", added_by=ROOT)
    await db_session.commit()
    created = await _create(client, account, headers)
    assert created.status_code == 201, created.text
    assert (await db_session.get(ApiKeyORM, created.json()["key"]["id"])).created_by == OTHER


async def test_a_super_admin_makes_a_key_without_managing_and_the_managers_are_told(
    client, db_session, account,
):
    headers = _sign_in(client, ROOT, global_perms=_ROOT_PERMS)
    created = await _create(client, account, headers)
    assert created.status_code == 201, created.text
    key = created.json()["key"]
    assert (await db_session.get(ApiKeyORM, key["id"])).created_by == ROOT

    [note] = await _notes(db_session, "service_account_key_created")
    assert (note.user_id, note.actor_id, note.link) == (
        OWNER, ROOT, f"/service-accounts/{account}",
    )
    assert "“Metadata sync”" in note.title and key["prefix"] in note.body


async def test_to_anyone_else_the_account_does_not_exist(client, db_session, account):
    for user_id, perms in ((ORG, _ORG_PERMS), (OTHER, ())):
        headers = _sign_in(client, user_id, global_perms=perms)
        assert (await client.get(_keys(account))).status_code == 404
        assert (await _create(client, account, headers)).status_code == 404
    _sign_in(client)
    assert (await client.get(_keys("svc_000000000000"))).status_code == 404
    # A person's id is not a service account's, even to someone who could act for any.
    _sign_in(client, ROOT, global_perms=_ROOT_PERMS)
    assert (await client.get(_keys(OWNER))).status_code == 404


async def test_minting_for_an_account_needs_proof_that_it_is_you(client, account):
    headers = _sign_in(client)
    refused = await _create(client, account, headers, currentPassword=None)
    assert refused.status_code == 403 and error(refused) == "step_up_required"
    wrong = await _create(client, account, headers, currentPassword="not it")
    assert wrong.status_code == 403 and error(wrong) == "step_up_failed"


# ── What a key may reach ────────────────────────────────────────────


async def test_a_key_reaches_what_the_account_reaches_not_what_its_manager_does(client, account):
    headers = _sign_in(client)
    options = (await client.get(f"{_keys(account)}/options")).json()
    assert [w["id"] for w in options["workspaces"]] == ["ws_a", "ws_c"]
    assert options["activeKeys"] == 0 and options["stepUp"]["method"] == "password"
    sources = (await client.get(f"{_keys(account)}/resources", params={"type": "data_source"})).json()
    assert {s["id"] for s in sources} == {"ds_a", "ds_a2"}

    managers_only = await _create(client, account, headers, resources={"workspaces": ["ws_b"]})
    assert managers_only.status_code == 422
    assert managers_only.json()["detail"]["unknown"] == {"workspaces": ["ws_b"]}
    accounts_only = await _create(client, account, headers, resources={"workspaces": ["ws_c"]})
    assert accounts_only.status_code == 201, accounts_only.text

    preview = await client.post(f"{_keys(account)}/preview", json={
        k: v for k, v in _body(resources={"workspaces": ["ws_a"]}).items() if k != "currentPassword"
    }, headers=headers)
    assert preview.status_code == 200, preview.text
    assert [w["id"] for w in preview.json()["effectiveAccess"]["workspaces"]] == ["ws_a"]
    assert preview.json()["activeKeys"] == 1


async def test_the_key_lists_data_sources_with_their_versioning_and_reads_the_commit_log(
    client, account,
):
    from backend.app.main import app

    class _Versioning(_FakeVersioning):
        async def main_heads(self, *, workspace_id, data_source_ids):
            return {"ds_a": {
                "graph_id": "g_a", "kind": "source", "main_head_commit_seq": 7,
                "main_head_commit_id": "c_7", "main_head_committed_at": "2026-10-01T00:00:00+00:00",
            }}

        async def commit_log_page(self, **_kwargs):
            return [], False

    app.dependency_overrides[versioning_endpoints.get_versioning_service] = _Versioning
    headers = _sign_in(client)
    token = (await _create(client, account, headers, permissions={"views": "none", "data": "read"}))
    token = token.json()["token"]
    client.cookies.clear()
    auth = {"Authorization": f"Bearer {token}"}

    listed = await client.get(
        "/api/v1/admin/workspaces/ws_a/data-sources", params={"include": "versioning"}, headers=auth,
    )
    assert listed.status_code == 200, listed.text
    versioning = {d["id"]: d["versioning"] for d in listed.json()}
    assert versioning["ds_a"]["mainHeadCommitSeq"] == 7 and versioning["ds_a2"]["enabled"] is False
    log = await client.get("/api/v1/ws_a/versioning/graphs/g_a/commits", headers=auth)
    assert log.status_code == 200, log.text
    # Not where the account has no role, whoever made the key.
    assert (await client.get("/api/v1/admin/workspaces/ws_b/data-sources", headers=auth)).status_code == 403


async def test_the_limit_is_the_accounts_own(client, db_session, account, monkeypatch):
    monkeypatch.setattr(api_keys_endpoints, "MAX_ACTIVE_KEYS", 1)
    await mint(db_session, OWNER, views="read")  # the manager's own key
    headers = _sign_in(client)
    assert (await _create(client, account, headers)).status_code == 201
    second = await _create(client, account, headers)
    assert second.status_code == 409 and error(second) == "too_many_api_keys"
    assert second.json()["detail"]["message"].startswith("“Metadata sync” can have 1 active keys.")


# ── A disabled account ──────────────────────────────────────────────


async def test_a_disabled_account_gets_no_new_keys_but_its_old_ones_can_be_ended(
    client, db_session, account,
):
    key = await _minted(db_session, account)
    (await db_session.get(UserORM, account)).status = "suspended"
    await db_session.commit()
    headers = _sign_in(client)
    created = await _create(client, account, headers)
    assert created.status_code == 409 and error(created) == "service_account_disabled"
    rotated = await client.post(
        f"{_keys(account)}/{key.id}/rotate", json={"currentPassword": PASSWORD}, headers=headers,
    )
    assert rotated.status_code == 409 and error(rotated) == "service_account_disabled"

    listed = await client.get(_keys(account))
    assert [(k["id"], k["status"]) for k in listed.json()] == [(key.id, "owner_inactive")]
    revoked = await client.delete(f"{_keys(account)}/{key.id}", headers=headers)
    assert revoked.status_code == 204


# ── Rotating and revoking ───────────────────────────────────────────


async def test_rotating_keeps_the_key_with_the_account(client, db_session, account):
    old = await _minted(db_session, account, expires_at=_in(30))
    headers = _sign_in(client)
    rotated = await client.post(
        f"{_keys(account)}/{old.id}/rotate", json={"currentPassword": PASSWORD}, headers=headers,
    )
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["token"].startswith("nxsat_")
    new = await db_session.get(ApiKeyORM, rotated.json()["key"]["id"])
    assert (new.user_id, new.kind, new.created_by, new.rotated_from) == (
        account, "service", OWNER, old.id,
    )
    ended = await db_session.get(ApiKeyORM, old.id)
    await db_session.refresh(ended)
    assert (ended.revoked_by, ended.revoked_reason) == (OWNER, "rotated")


async def test_a_manager_revoking_is_recorded_as_one(client, db_session, account):
    key = await _minted(db_session, account)
    headers = _sign_in(client)
    revoked = await client.delete(f"{_keys(account)}/{key.id}", headers=headers)
    assert revoked.status_code == 204
    row = await db_session.get(ApiKeyORM, key.id)
    await db_session.refresh(row)
    assert (row.revoked_by, row.revoked_reason) == (OWNER, "manager")
    assert await _notes(db_session, "api_key_revoked_by_admin") == []


async def test_a_super_admin_revoking_tells_the_managers(client, db_session, account):
    key = await _minted(db_session, account)
    headers = _sign_in(client, ROOT, global_perms=_ROOT_PERMS)
    revoked = await client.delete(f"{_keys(account)}/{key.id}", headers=headers)
    assert revoked.status_code == 204
    row = await db_session.get(ApiKeyORM, key.id)
    await db_session.refresh(row)
    assert (row.revoked_by, row.revoked_reason) == (ROOT, "admin")
    [note] = await _notes(db_session, "api_key_revoked_by_admin")
    assert (note.user_id, note.link) == (OWNER, f"/service-accounts/{account}")
    assert note.title == "An administrator revoked one of “Metadata sync”’s API keys"


# ── A person's own keys stay theirs ─────────────────────────────────


async def test_a_managers_own_keys_and_the_accounts_never_mix(client, db_session, account):
    own = await mint(db_session, OWNER, views="read")
    theirs = await _minted(db_session, account)
    _sign_in(client)
    assert [k["id"] for k in (await client.get("/api/v1/me/api-keys")).json()] == [own.id]
    assert [k["id"] for k in (await client.get(_keys(account))).json()] == [theirs.id]
    assert (await client.get(f"/api/v1/me/api-keys/{theirs.id}")).status_code == 404
    assert (await client.get(f"{_keys(account)}/{own.id}")).status_code == 404
    options = (await client.get("/api/v1/me/api-keys/options")).json()
    assert [w["id"] for w in options["workspaces"]] == ["ws_a", "ws_b"]


# ── Who hears about a key ───────────────────────────────────────────


async def test_misuse_of_an_accounts_key_is_told_to_its_managers(client, db_session, account):
    key = await _minted(db_session, account)
    await api_key_repo.revoke(db_session, key.id, by=OWNER, reason="manager")
    await db_session.commit()
    refused = await client.get("/api/v1/views/v_a_ws", headers=key.headers)
    assert refused.status_code == 401

    [note] = await _notes(db_session, "api_key_misuse")
    assert (note.user_id, note.link) == (OWNER, f"/service-accounts/{account}")
    assert note.body.startswith("“Metadata sync”’s key “ci key”")


async def test_an_administrator_revoking_an_accounts_keys_tells_its_managers(
    client, db_session, account,
):
    one = await _minted(db_session, account, name="one")
    await _minted(db_session, account, name="two")
    headers = _sign_in(client, ROOT, global_perms=_ROOT_PERMS)
    revoked = await client.post(
        f"/api/v1/admin/api-keys/{one.id}/revoke", json={"note": "Leaked in a log"}, headers=headers,
    )
    assert revoked.status_code == 204, revoked.text
    everything = await client.post(
        f"/api/v1/admin/users/{account}/api-keys/revoke-all", headers=headers,
    )
    assert everything.json() == {"revoked": 1}

    notes = await _notes(db_session, "api_key_revoked_by_admin")
    assert [(n.user_id, n.link) for n in notes] == [(OWNER, f"/service-accounts/{account}")] * 2
    assert {n.title for n in notes} == {
        "An administrator revoked one of “Metadata sync”’s API keys",
        "An administrator revoked “Metadata sync”’s API keys",
    }


async def test_expiry_reminders_go_to_the_managers_or_with_none_left_to_the_admins(
    client, db_session, account,
):
    soon = _in(3)
    first = await _minted(db_session, account, name="first", expires_at=soon)
    (await db_session.get(ApiKeyORM, first.id)).created_at = days_ago(60)
    await db_session.commit()
    assert await api_key_housekeeping.remind_once(db_session) == 1
    [note] = await _notes(db_session, "api_key_expiring")
    assert (note.user_id, note.link) == (OWNER, f"/service-accounts/{account}")
    assert note.body.startswith("“Metadata sync”’s key “first”")

    # Its only manager leaves: the administrators answer for it now.
    (await db_session.get(UserORM, OWNER)).status = "suspended"
    await db_session.commit()
    await service_account_standing.refresh(db_session, [account])
    second = await _minted(db_session, account, name="second", expires_at=soon)
    (await db_session.get(ApiKeyORM, second.id)).created_at = days_ago(60)
    await db_session.commit()
    assert await api_key_housekeeping.remind_once(db_session) == 1
    told = [n for n in await _notes(db_session, "api_key_expiring") if n.resource_id == second.id]
    assert [(n.user_id, n.link) for n in told] == [(ROOT, f"/service-accounts/{account}")]


async def test_a_persons_own_key_notices_read_as_before(client, db_session):
    audience = await service_account_standing.key_audience(db_session, OWNER)
    assert (audience.user_ids, audience.link, audience.whose) == ({OWNER}, "/me/api-keys", "your")
    row = await api_key_repo.get(db_session, (await mint(db_session, OWNER, name="mine")).id)
    assert audience.key(row) == f"Your key “mine” ({row.token_prefix}…)"
