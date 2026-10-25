"""API key tokens and the rows behind them.

The token format is a contract with every client and every secret scanner,
and the repository is what the per-request lookup and the owner's own pages
stand on — so both are pinned here, below any HTTP.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError
from starlette.datastructures import Headers

from backend.app.db.models import ApiKeyORM, IdpProviderORM, ServiceAccountORM, UserIdentityORM, UserORM
from backend.app.db.repositories import api_key_repo
from backend.auth_service.core import api_keys


# ── Format ──────────────────────────────────────────────────────────


def test_a_personal_key_is_prefixed_checksummed_and_valid():
    key = api_keys.generate()
    assert key.token.startswith("nxpat_")
    assert len(key.token) == api_keys.TOKEN_LENGTH == 44
    assert api_keys.looks_valid(key.token)
    assert api_keys.kind_of(key.token) == api_keys.KIND_PERSONAL
    assert key.display_prefix == key.token[:14]


def test_service_account_keys_have_their_own_prefix():
    key = api_keys.generate(api_keys.KIND_SERVICE)
    assert key.token.startswith("nxsat_")
    assert api_keys.looks_valid(key.token)
    assert api_keys.kind_of(key.token) == api_keys.KIND_SERVICE


def test_keys_do_not_repeat():
    tokens = {api_keys.generate().token for _ in range(500)}
    assert len(tokens) == 500


def test_the_pattern_the_guide_gives_secret_scanners_finds_every_key():
    """The API Keys guide tells people what to add to their secret scanner: it
    must go on finding every key this code makes."""
    guide = (Path(__file__).parents[2] / "docs" / "guide" / "API_KEYS.md").read_text(encoding="utf-8")
    found = re.search(r"^(nx\S*at_\S+)$", guide, re.MULTILINE)
    assert found, "the guide no longer gives secret scanners a pattern"
    pattern = re.compile(found.group(1))
    for kind in (api_keys.KIND_PERSONAL, api_keys.KIND_SERVICE):
        assert all(pattern.fullmatch(api_keys.generate(kind).token) for _ in range(500))


def test_only_the_hash_is_derived_and_it_is_stable():
    key = api_keys.generate()
    assert key.token_hash == api_keys.hash_token(key.token)
    assert len(key.token_hash) == 64
    assert key.token not in key.token_hash


def test_every_single_character_typo_is_caught_by_the_checksum():
    token = api_keys.generate().token
    for i in range(6, len(token)):
        replacement = "A" if token[i] != "A" else "B"
        mutated = token[:i] + replacement + token[i + 1:]
        assert not api_keys.looks_valid(mutated), f"typo at {i} passed"


@pytest.mark.parametrize("candidate", [
    None, "", "nxpat_", "nxpat_short",
    "ghp_" + "a" * 40,                                    # someone else's prefix
    "nxpat_" + "a" * 37,                                  # one short
    "nxpat_" + "a" * 39,                                  # one long
    "nxpat_" + "a" * 31 + "-" + "a" * 6,                  # outside the alphabet
])
def test_malformed_tokens_are_refused_without_a_lookup(candidate):
    assert not api_keys.looks_valid(candidate)


# ── Reading one off a request ───────────────────────────────────────


def test_a_bearer_key_is_read_from_the_authorization_header():
    token = api_keys.generate().token
    assert api_keys.bearer_api_key({"authorization": f"Bearer {token}"}) == token
    # RFC 6750: the scheme is case-insensitive.
    assert api_keys.bearer_api_key({"authorization": f"bearer  {token} "}) == token
    assert api_keys.bearer_api_key(Headers({"Authorization": f"Bearer {token}"})) == token


def test_a_malformed_key_is_still_recognised_as_a_key_attempt():
    """Recognition is by prefix: a request that claims a key is treated as a
    key request — refused if bad — and never quietly falls back to cookies."""
    assert api_keys.bearer_api_key({"authorization": "Bearer nxpat_nonsense"}) == "nxpat_nonsense"


@pytest.mark.parametrize("header", [
    None, "", "Bearer", "Basic dXNlcjpwYXNz", "Bearer some-other-token",
    "Token nxpat_" + "a" * 38,
])
def test_anything_else_in_authorization_is_not_a_key(header):
    headers = {} if header is None else {"authorization": header}
    assert api_keys.bearer_api_key(headers) is None


# ── Addresses ───────────────────────────────────────────────────────


@pytest.mark.parametrize("raw, address", [
    ("203.0.113.9", "203.0.113.9"),
    (" 203.0.113.9 ", "203.0.113.9"),
    ("::ffff:203.0.113.9", "203.0.113.9"),       # IPv4 behind a dual-stack socket
    ("2001:DB8::1", "2001:db8::1"),
    ("203.0.113.9, 10.0.0.1", None),             # a forwarded-for list, unparsed
    ("unknown", None),
    ("<b>evil</b>", None),
    ("", None),
    (None, None),
])
def test_only_an_address_is_ever_recorded_as_one(raw, address):
    """What a proxy passes on reaches notifications and the audit log only
    as the canonical text of an address — or not at all."""
    assert api_keys.client_address(raw) == address


def test_refused_keys_are_budgeted_per_address_and_per_ipv6_host():
    assert api_keys.address_bucket("203.0.113.9") == "203.0.113.9"
    assert api_keys.address_bucket("::ffff:203.0.113.9") == "203.0.113.9"
    # One IPv6 host may rotate through its whole /64 at will.
    assert (
        api_keys.address_bucket("2001:db8:1:2::5")
        == api_keys.address_bucket("2001:db8:1:2:ffff::9")
        == "2001:db8:1:2::/64"
    )
    assert api_keys.address_bucket("2001:db8:1:3::5") != api_keys.address_bucket("2001:db8:1:2::5")
    assert api_keys.address_bucket(None) == api_keys.address_bucket("garbage") == "unknown"


# ── Rows ────────────────────────────────────────────────────────────


async def _user(
    session, user_id: str, *, email: str | None = None, password: bool = False,
    status: str = "active",
) -> UserORM:
    row = UserORM(
        id=user_id, email=email or f"{user_id}@example.com",
        password_hash="not-a-real-hash" if password else "x-disabled-password-x",
        first_name="A", last_name="B", status=status,
    )
    session.add(row)
    await session.flush()
    return row


async def _key(session, user_id: str, **overrides):
    generated = api_keys.generate()
    fields = dict(
        user_id=user_id, kind="personal", created_by=user_id, name="ci",
        description=None, token_prefix=generated.display_prefix,
        token_hash=generated.token_hash,
        permissions={"views": "read", "data": "none", "publish": False},
        resources="all", allowed_cidrs=None, expires_at=None,
        created_ip="10.0.0.1", created_user_agent="pytest",
    )
    fields.update(overrides)
    return generated, await api_key_repo.create(session, **fields)


def _idp(session) -> None:
    session.add(IdpProviderORM(
        id="idp_x", slug="x", display_name="X", kind="oidc", settings="{}", linking_policy="strict",
    ))


async def test_the_auth_lookup_returns_key_owner_and_identity_facts(db_session):
    await _user(db_session, "usr_owner1")
    _idp(db_session)
    db_session.add(UserIdentityORM(
        user_id="usr_owner1", provider_id="idp_x", external_id="sub-1",
        last_login_at="2026-10-01T00:00:00+00:00",
    ))
    generated, row = await _key(db_session, "usr_owner1")

    found = await api_key_repo.find_for_auth(db_session, generated.token_hash)
    assert found is not None
    assert found.key.id == row.id
    assert found.owner.id == "usr_owner1"
    assert found.identity_count == 1
    assert found.idp_last_login_at == "2026-10-01T00:00:00+00:00"

    assert await api_key_repo.find_for_auth(db_session, "0" * 64) is None


async def test_owner_scoped_reads_never_return_someone_elses_key(db_session):
    await _user(db_session, "usr_a")
    await _user(db_session, "usr_b")
    _, mine = await _key(db_session, "usr_a")
    _, theirs = await _key(db_session, "usr_b")

    assert (await api_key_repo.get_for_user(db_session, "usr_a", mine.id)).id == mine.id
    assert await api_key_repo.get_for_user(db_session, "usr_a", theirs.id) is None
    assert [k.id for k in await api_key_repo.list_for_user(db_session, "usr_a")] == [mine.id]


async def test_a_token_hash_can_belong_to_one_key_only(db_session):
    await _user(db_session, "usr_dup")
    generated, _ = await _key(db_session, "usr_dup")
    with pytest.raises(IntegrityError):
        await _key(db_session, "usr_dup", token_hash=generated.token_hash)
    await db_session.rollback()


async def test_revocation_is_recorded_once(db_session):
    await _user(db_session, "usr_rev")
    _, row = await _key(db_session, "usr_rev")
    assert await api_key_repo.revoke(db_session, row.id, by="usr_rev", reason="owner")
    assert not await api_key_repo.revoke(db_session, row.id, by="usr_admin", reason="admin")
    await db_session.refresh(row)
    assert row.revoked_by == "usr_rev" and row.revoked_reason == "owner"
    assert not api_key_repo.is_active(row)


async def test_rotation_grace_can_only_bring_expiry_forward(db_session):
    await _user(db_session, "usr_grace")
    later = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    sooner = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    _, row = await _key(db_session, "usr_grace", expires_at=sooner)
    await api_key_repo.set_expiry(db_session, row.id, later)
    await db_session.refresh(row)
    assert row.expires_at == sooner


async def test_last_used_is_written_once_per_window(db_session):
    await _user(db_session, "usr_touch")
    _, row = await _key(db_session, "usr_touch")
    await api_key_repo.touch_last_used(
        db_session, row.id, ip="10.1.1.1", user_agent="one", resolution_seconds=300,
    )
    await db_session.refresh(row)
    first = row.last_used_at
    assert first and row.last_used_ip == "10.1.1.1"

    await api_key_repo.touch_last_used(
        db_session, row.id, ip="10.2.2.2", user_agent="two", resolution_seconds=300,
    )
    await db_session.refresh(row)
    assert row.last_used_at == first and row.last_used_ip == "10.1.1.1"


async def test_the_inventory_filters_by_status_and_owner(db_session):
    await _user(db_session, "usr_inv", email="inv@example.com", password=True)
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    _, active = await _key(db_session, "usr_inv", name="active one")
    _, expired = await _key(db_session, "usr_inv", name="expired one", expires_at=past)
    _, revoked = await _key(db_session, "usr_inv", name="revoked one")
    await api_key_repo.revoke(db_session, revoked.id, by="usr_inv", reason="owner")

    async def ids(**kw):
        rows, total = await api_key_repo.list_all(db_session, **kw)
        assert total == len(rows)
        return {k.id for k, _owner in rows}

    assert await ids(status="active") == {active.id}
    assert await ids(status="expired") == {expired.id}
    assert await ids(status="revoked") == {revoked.id}
    assert await ids(owner_id="usr_inv") == {active.id, expired.id, revoked.id}
    assert await ids(search="inv@example") == {active.id, expired.id, revoked.id}
    assert await ids(search="expired") == {expired.id}


async def test_the_per_person_limit_counts_keys_still_in_date(db_session):
    await _user(db_session, "usr_count", password=True)
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    await _key(db_session, "usr_count")
    _, old = await _key(db_session, "usr_count")
    old.created_at = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    await _key(db_session, "usr_count", expires_at=past)
    _, revoked = await _key(db_session, "usr_count")
    await api_key_repo.revoke(db_session, revoked.id, by="usr_count", reason="owner")
    await db_session.flush()
    assert await api_key_repo.count_active_for_user(db_session, "usr_count") == 2
    # A key past the deployment's maximum lifetime is not in date either.
    assert await api_key_repo.count_active_for_user(
        db_session, "usr_count", max_lifetime_days=30,
    ) == 1


_SHOWN = {None: "active", "owner_reauth_required": "paused", "unmanaged": "paused"}


async def test_the_status_the_inventory_filters_on_is_the_one_every_request_gets(db_session):
    """``status_expr`` filters and counts the administrators' inventory;
    ``lifecycle_refusal`` decides each request. For every kind of owner —
    people, and service accounts with and without a manager — key and policy,
    they agree."""
    now = datetime.now(timezone.utc)

    def ago(days: float) -> str:
        return (now - timedelta(days=days)).isoformat()

    owners = {
        "usr_pw": {}, "usr_nopw": {}, "usr_off": {"status": "suspended"}, "usr_deleted": {},
        "usr_sso_fresh": {}, "usr_sso_stale": {}, "usr_sso_never": {}, "usr_sys": {},
    }
    passwords = {"usr_pw", "usr_off", "usr_deleted", "usr_sso_stale", "usr_sys"}
    users = {}
    for uid, extra in owners.items():
        users[uid] = await _user(db_session, uid, password=uid in passwords, **extra)
    users["usr_deleted"].deleted_at = ago(1)
    users["usr_sys"].is_system_account = True
    last_login = {"usr_sso_fresh": ago(1), "usr_sso_stale": ago(40), "usr_sso_never": None}
    _idp(db_session)
    for uid, last in last_login.items():
        db_session.add(UserIdentityORM(
            user_id=uid, provider_id="idp_x", external_id=f"sub-{uid}", last_login_at=last,
        ))
    # Service accounts: managed, without a manager for a few days, for
    # longer than any grace, and disabled.
    unmanaged = {"svc_managed": None, "svc_recent": ago(3), "svc_lapsed": ago(40), "svc_off": None}
    for uid, since in unmanaged.items():
        users[uid] = await _user(db_session, uid, status="suspended" if uid == "svc_off" else "active")
        db_session.add(ServiceAccountORM(user_id=uid, unmanaged_since=since))
    # And one whose record is gone, as a rollback of its tables leaves it.
    users["svc_orphan"] = await _user(db_session, "svc_orphan")
    keys, plain = [], {}
    for uid in [*owners, *unmanaged, "svc_orphan"]:
        kind = "service" if uid.startswith("svc_") else "personal"
        for expires_at, created_at, revoked in (
            (None, None, False),
            ((now + timedelta(days=5)).isoformat(), None, False),
            (ago(1), None, False),
            (None, ago(40), False),              # past a 30-day maximum lifetime
            (ago(1), None, True),
        ):
            _, row = await _key(db_session, uid, kind=kind, expires_at=expires_at)
            row.created_at = created_at or row.created_at
            row.revoked_at = ago(0) if revoked else None
            keys.append(row)
            plain.setdefault(uid, row)
    # A key whose kind and owner disagree never works.
    _, crossed_to_person = await _key(db_session, "usr_pw", kind="service")
    _, crossed_to_account = await _key(db_session, "svc_managed", kind="personal")
    keys += [crossed_to_person, crossed_to_account]
    await db_session.flush()

    seen = set()
    for cap, window, passwords, grace in (
        (None, 30, True, 14), (30, 30, True, 14), (30, None, True, 0), (None, None, True, 14),
        (None, 30, False, 0), (30, None, False, 14),
    ):
        base, status = api_key_repo._inventory(now, cap, window, passwords, grace)
        in_sql = dict((await db_session.execute(
            base.with_only_columns(ApiKeyORM.id, status)
        )).all())
        for key in keys:
            refusal = api_keys.lifecycle_refusal(
                key, users[key.user_id],
                identity_count=int(key.user_id in last_login),
                idp_last_login_at=last_login.get(key.user_id),
                now=now, sso_signin_window_days=window, max_lifetime_days=cap,
                passwords_allowed=passwords,
                unmanaged_since=unmanaged.get(key.user_id), unmanaged_grace_days=grace,
                account_on_record=not key.user_id.startswith("svc_") or key.user_id in unmanaged,
            )
            shown = _SHOWN.get(refusal, refusal)
            assert in_sql[key.id] == shown, (
                key.user_id, key.kind, cap, window, passwords, grace, key.expires_at,
            )
            if key in (crossed_to_person, crossed_to_account):
                assert shown != "active", (key.user_id, key.kind)
            if key.user_id == "usr_sys":
                assert shown != "active", (cap, window, key.expires_at)
            if key.user_id == "usr_pw" and not passwords:
                # A password is no way back in while password sign-in is off.
                assert shown != "active", (cap, window, key.expires_at)
            seen.add(shown)
        # A service account's keys work while it is managed, and through the
        # grace period after; then they pause. A disabled account's stop.
        assert in_sql[plain["svc_managed"].id] == "active"
        assert in_sql[plain["svc_recent"].id] == ("active" if grace > 3 else "paused")
        assert in_sql[plain["svc_lapsed"].id] == "paused"
        assert in_sql[plain["svc_off"].id] == "owner_inactive"
        assert in_sql[plain["svc_orphan"].id] == "owner_inactive"
    assert seen == {"active", "paused", "owner_inactive", "expired", "revoked"}
