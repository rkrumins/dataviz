"""API key tokens and the rows behind them.

The token format is a contract with every client and every secret scanner,
and the repository is what the per-request lookup and the owner's own pages
stand on — so both are pinned here, below any HTTP.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.exc import IntegrityError
from starlette.datastructures import Headers

from backend.app.db.models import UserIdentityORM, UserORM
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


# ── Rows ────────────────────────────────────────────────────────────


async def _user(session, user_id: str, *, email: str | None = None) -> UserORM:
    row = UserORM(
        id=user_id, email=email or f"{user_id}@example.com",
        password_hash="x-disabled-password-x", first_name="A", last_name="B",
        status="active",
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


async def test_the_auth_lookup_returns_key_owner_and_identity_facts(db_session):
    await _user(db_session, "usr_owner1")
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
    await _user(db_session, "usr_inv", email="inv@example.com")
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
