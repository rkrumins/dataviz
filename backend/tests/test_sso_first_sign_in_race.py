"""Two first sign-ins for one person must not end in a database error.

Tabs restored together each run the sign-in page's automatic gateway
sign-in; a double submit does the same. Both requests read "no account",
both create it, and the one that commits second hits ``uq_users_email`` —
which reached people as "the database is temporarily unavailable". The
loser now reads again and signs in to the account the winner created.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from backend.app.db.models import UserORM
from backend.app.db.repositories import (
    idp_provider_repo, user_identity_repo, user_repo,
)
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.interface import SSOAuthError
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService

EMAIL = "ada@corp.example"


def _identity() -> ProviderIdentity:
    return ProviderIdentity(
        provider="backchannel", external_id="emp-ada", email=EMAIL,
        first_name="Ada", last_name="Lovelace",
        raw_claims={"email_verified": True},
    )


def _scope(db_session):
    """Like the production session scope: commit on success, roll back on
    error — which is what lets a lost race leave nothing behind."""
    @asynccontextmanager
    async def factory():
        try:
            yield db_session
            await db_session.commit()
        except BaseException:
            await db_session.rollback()
            raise
    return factory


def _service(db_session, users) -> LocalIdentityService:
    return LocalIdentityService(
        session_factory=_scope(db_session),
        user_repo=users,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=make_refresh_store,
    )


async def _provider(db_session):
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-gw", display_name="Corporate Gateway",
        kind="backchannel", settings={"gateway_url": "https://gw.example/redeem",
                                      "token_source_key": "corp_session"},
        claim_mapping={}, linking_policy="strict",
    )
    await db_session.commit()
    return row


class _RacedUsers:
    """The real user repo, except that the first provisioning finds the
    other tab's sign-in already committed — the account AND its identity
    — between this request's read and its insert."""

    def __init__(self, provider_id: str):
        self._provider_id = provider_id
        self.winner_id = None

    def __getattr__(self, name):
        return getattr(user_repo, name)

    async def create_sso_user(self, session, **kwargs):
        if self.winner_id is None:
            winner = await user_repo.create_sso_user(session, **kwargs)
            await user_identity_repo.create_identity(
                session, user_id=winner.id, provider_id=self._provider_id,
                external_id="emp-ada", email_at_link=EMAIL, metadata={},
            )
            await session.commit()
            self.winner_id = winner.id
        return await user_repo.create_sso_user(session, **kwargs)


async def _accounts(db_session) -> int:
    return (await db_session.execute(
        select(func.count()).select_from(UserORM).where(UserORM.email == EMAIL)
    )).scalar_one()


@pytest.mark.asyncio
async def test_the_loser_of_a_first_sign_in_race_signs_in_to_the_winners_account(
    db_session,
):
    provider = await _provider(db_session)
    users = _RacedUsers(provider.id)

    user, tokens = await _service(db_session, users).complete_sso_login(
        _identity(), provider_id=provider.id, provider_slug=provider.slug,
    )

    assert users.winner_id is not None, "the race was not staged"
    assert user.id == users.winner_id
    assert tokens.access_token
    assert await _accounts(db_session) == 1


@pytest.mark.asyncio
async def test_a_conflict_that_survives_the_re_read_is_a_clean_refusal(db_session):
    """Not a race: an account the email lookup cannot see still holds the
    address — here a soft-deleted one. Refused like any sign-in that cannot
    complete, with a reason, instead of "the database is unavailable"."""
    provider = await _provider(db_session)
    held = await user_repo.create_user(
        db_session, email=EMAIL, password_hash="x", first_name="Old",
        last_name="Account", status="active",
    )
    held.deleted_at = datetime.now(timezone.utc).isoformat()
    await db_session.commit()

    with pytest.raises(SSOAuthError) as err:
        await _service(db_session, user_repo).complete_sso_login(
            _identity(), provider_id=provider.id, provider_slug=provider.slug,
        )
    assert str(err.value) == "account_conflict"
