"""Session revocation has to survive a token refresh.

Revoking sessions tombstones live access-token ``sid``s in Redis. On its
own that signs nobody out: the tombstone expires with the access token,
and ``LocalIdentityService.refresh`` mints a FRESH random ``sid`` on
every rotation rather than carrying the old one forward. A client that
eats one 401 and silently refreshes — which the SPA does automatically —
comes straight back with a ``sid`` that was never on the revoked list.

``users.sessions_valid_from`` is the durable half: a refresh token
issued before the cutoff is refused and its family killed. These tests
are the reason that column exists, so they assert the property end to
end (through ``POST /auth/refresh``) rather than only unit-testing the
comparison.

The unit-level edge cases live at the bottom — chiefly that the check
fails OPEN when it cannot tell, so deploying the cutoff does not sign
the entire estate out.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo
from backend.auth_service.cookies import ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME
from backend.auth_service.service import _refresh_predates_cutoff


_PASSWORD = "C0mpl3x!Passw0rd#"
_EMAIL = "cutoff@example.com"


@pytest.fixture(autouse=True)
def _disable_auth_rate_limits():
    """``/auth/login`` is 10/minute and every test shares one client IP.

    This module signs in repeatedly by design, so without this it eats
    the budget and starts 429-ing tests in *other* files. Mirrors
    ``test_invite_roles.py``.
    """
    from backend.auth_service.api import router as _auth_router
    prev = _auth_router.limiter.enabled
    _auth_router.limiter.enabled = False
    yield
    _auth_router.limiter.enabled = prev


async def _seed(db_session: AsyncSession) -> str:
    user = await user_repo.create_user(
        db_session,
        email=_EMAIL,
        password_hash=hash_password(_PASSWORD),
        first_name="Cut",
        last_name="Off",
        status="active",
    )
    await user_repo.assign_role(db_session, user.id, "workspace_member")
    await db_session.commit()
    return user.id


async def _login(test_client: AsyncClient) -> None:
    resp = await test_client.post(
        "/api/v1/auth/login", json={"email": _EMAIL, "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text


# ── The property ─────────────────────────────────────────────────────

async def test_refresh_works_before_any_revocation(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """Baseline: without a cutoff, refresh rotates normally."""
    await _seed(db_session)
    await _login(test_client)

    resp = await test_client.post("/api/v1/auth/refresh")
    assert resp.status_code == 200, resp.text
    assert ACCESS_COOKIE_NAME in resp.cookies
    assert REFRESH_COOKIE_NAME in resp.cookies


async def test_refresh_is_refused_after_sessions_revoked(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The regression this column exists to prevent.

    Before the cutoff, this refresh succeeded and handed the caller a
    brand-new un-revoked session — which is what made "sign out
    everywhere" a false claim.
    """
    user_id = await _seed(db_session)
    await _login(test_client)

    await user_repo.revoke_sessions_from_now(db_session, user_id)
    await db_session.commit()

    resp = await test_client.post("/api/v1/auth/refresh")
    assert resp.status_code == 401, resp.text


async def test_login_after_revocation_works_again(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """The cutoff kills existing sessions, not the account.

    A stamp that also locked the user out of signing back in would be a
    denial of service with extra steps.
    """
    user_id = await _seed(db_session)
    await user_repo.revoke_sessions_from_now(db_session, user_id)
    await db_session.commit()

    await _login(test_client)
    resp = await test_client.post("/api/v1/auth/refresh")
    assert resp.status_code == 200, resp.text


async def test_revocation_does_not_reach_other_users(
    test_client: AsyncClient, db_session: AsyncSession,
):
    """One person signing out everywhere must not sign out everyone."""
    await _seed(db_session)
    other = await user_repo.create_user(
        db_session,
        email="bystander@example.com",
        password_hash=hash_password(_PASSWORD),
        first_name="By", last_name="Stander", status="active",
    )
    await user_repo.assign_role(db_session, other.id, "workspace_member")
    await db_session.commit()

    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "bystander@example.com", "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text

    # Revoke the OTHER account's sessions.
    seeded = await user_repo.get_user_by_email(db_session, _EMAIL)
    await user_repo.revoke_sessions_from_now(db_session, seeded.id)
    await db_session.commit()

    assert (await test_client.post("/api/v1/auth/refresh")).status_code == 200


# ── The cutoff comparison ────────────────────────────────────────────
#
# Fail-open when there is no instruction to enforce: no cutoff, or a
# cutoff too malformed to read. A malformed column must never lock an
# account out of its own refresh path.
#
# Fail-CLOSED on the one remaining case — a readable cutoff plus a token
# that cannot say when it was minted. This used to fail open, on the
# stated grounds that deploying the cutoff should not sign the estate
# out. That reasoning does not apply: ``create_refresh_token`` has always
# set ``iat`` and the decoder falls back to it, so a token predating the
# ``mat`` claim still dates itself to the second and is judged normally.
# Reaching ``mint_ms == 0`` takes a token carrying NEITHER claim, which
# nothing here issues — so the case it was protecting was empty, while
# the hole it left was real: an operator says "sign every earlier session
# out" and an undateable token walks through the instruction.

_STAMP = "2026-07-28T00:00:00+00:00"
_STAMP_MS = 1785196800000  # 2026-07-28T00:00:00Z in epoch milliseconds


@pytest.mark.parametrize(
    "mint_ms,cutoff,expected,why",
    [
        (1_000_000, None, False, "no cutoff set"),
        (1_000_000, "", False, "empty cutoff"),
        (0, _STAMP, True, "undateable token cannot outlive a real cutoff"),
        (_STAMP_MS - 1, _STAMP, True, "minted one millisecond before"),
        (_STAMP_MS, _STAMP, False, "minted exactly at the cutoff"),
        (_STAMP_MS + 1, _STAMP, False, "minted one millisecond after"),
        (_STAMP_MS - 1, "2026-07-28T00:00:00", True, "naive stamp read as UTC"),
        (1_000_000, "not-a-date", False, "unparseable stamp is ignored"),
        (0, "not-a-date", False, "an unreadable cutoff condemns nothing"),
    ],
)
def test_cutoff_comparison(mint_ms, cutoff, expected, why):
    assert _refresh_predates_cutoff(mint_ms, cutoff) is expected, why


def test_cutoff_separates_tokens_minted_in_the_same_second():
    """The precision that second-granular ``iat`` could not give.

    Revoking and then signing straight back in happens inside one
    second routinely. At second resolution the new token is
    indistinguishable from the one just killed, so either it is wrongly
    refused or the old one wrongly survives.
    """
    doomed = _STAMP_MS - 200
    fresh = _STAMP_MS + 200
    assert _refresh_predates_cutoff(doomed, _STAMP) is True
    assert _refresh_predates_cutoff(fresh, _STAMP) is False
