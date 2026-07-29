"""``nx_access_exp`` — the client's only way to see its own expiry.

The access cookie is ``HttpOnly``, so the browser holds a token whose
lifetime it cannot read. That is why renewal was reactive: fire a
request, take the 401, refresh, replay. Every renewal cost a
user-visible request the full round trip, and an idle tab issued no
request at all — so whether it renewed came down to whether an unrelated
poller happened to fire before the refresh window closed.

Publishing the expiry instant lets the client rotate *before* the token
dies. These tests pin the three properties the scheduler depends on: it
is set on both mints, it outlives the token it describes, and logout
takes it away.
"""
import time

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo
from backend.auth_service.cookies import (
    ACCESS_COOKIE_NAME,
    ACCESS_EXPIRY_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
)
from backend.auth_service.core.config import JWT_EXPIRY_MINUTES


_PASSWORD = "C0mpl3x!Passw0rd#"
_EMAIL = "expiry@example.com"


async def _seed(db_session: AsyncSession) -> str:
    user = await user_repo.create_user(
        db_session,
        email=_EMAIL,
        password_hash=hash_password(_PASSWORD),
        first_name="Expiry",
        last_name="Tester",
        status="active",
    )
    await user_repo.assign_role(db_session, user.id, "super_admin")
    await db_session.commit()
    return user.id


async def _login(client: AsyncClient):
    return await client.post(
        "/api/v1/auth/login", json={"email": _EMAIL, "password": _PASSWORD},
    )


def _set_cookie_header(resp, name: str) -> str:
    """The raw Set-Cookie line for *name*.

    ``resp.cookies`` drops the attributes, and the attributes are the
    whole point for the assertions below.
    """
    for header in resp.headers.get_list("set-cookie"):
        if header.startswith(f"{name}="):
            return header
    raise AssertionError(f"no Set-Cookie for {name} in {resp.headers}")


async def test_login_publishes_the_access_expiry(
    test_client: AsyncClient, db_session: AsyncSession
):
    await _seed(db_session)
    resp = await _login(test_client)
    assert resp.status_code == 200, resp.text

    raw = resp.cookies.get(ACCESS_EXPIRY_COOKIE_NAME)
    assert raw, "client cannot schedule a renewal it cannot see"

    # Tracks the access TTL, within a generous allowance for the round
    # trip — pinning it exactly would just be re-deriving the arithmetic.
    remaining = int(raw) - int(time.time())
    assert abs(remaining - JWT_EXPIRY_MINUTES * 60) <= 30


async def test_the_expiry_cookie_is_readable_by_script(
    test_client: AsyncClient, db_session: AsyncSession
):
    """An ``HttpOnly`` expiry cookie would be silently useless.

    Nothing would fail — the cookie would be set, sent, and invisible to
    the code that exists to read it, so renewal would quietly stay
    reactive with no error anywhere to say why.
    """
    await _seed(db_session)
    resp = await _login(test_client)
    header = _set_cookie_header(resp, ACCESS_EXPIRY_COOKIE_NAME)
    assert "httponly" not in header.lower()
    # The access cookie it describes must stay HttpOnly.
    assert "httponly" in _set_cookie_header(resp, ACCESS_COOKIE_NAME).lower()


async def test_the_expiry_cookie_outlives_the_access_cookie(
    test_client: AsyncClient, db_session: AsyncSession
):
    """The case this exists for: a tab that boots after expiry.

    If Max-Age matched the access cookie, the browser would drop this
    at the exact moment it becomes useful — a tab restored an hour later
    would find no expiry, learn nothing, and fall back to discovering
    the dead session by 401. It has to survive as long as the refresh
    cookie, which is the thing that can still recover the session.
    """
    await _seed(db_session)
    resp = await _login(test_client)

    def _max_age(name: str) -> int:
        for part in _set_cookie_header(resp, name).split(";"):
            key, _, value = part.strip().partition("=")
            if key.lower() == "max-age":
                return int(value)
        raise AssertionError(f"{name} has no Max-Age")

    assert _max_age(ACCESS_EXPIRY_COOKIE_NAME) > _max_age(ACCESS_COOKIE_NAME)
    assert _max_age(ACCESS_EXPIRY_COOKIE_NAME) == _max_age(REFRESH_COOKIE_NAME)


async def test_refresh_republishes_the_expiry(
    test_client: AsyncClient, db_session: AsyncSession
):
    """Every rotation has to move it forward.

    A stale value is worse than none: the scheduler would keep firing
    against an instant already past, refreshing on a loop.
    """
    await _seed(db_session)
    login = await _login(test_client)
    first = login.cookies.get(ACCESS_EXPIRY_COOKIE_NAME)
    assert first

    refresh = await test_client.post("/api/v1/auth/refresh")
    assert refresh.status_code == 200, refresh.text
    second = refresh.cookies.get(ACCESS_EXPIRY_COOKIE_NAME)
    assert second, "rotation left the client scheduling against a dead instant"
    assert int(second) >= int(first)


async def test_logout_clears_the_expiry(
    test_client: AsyncClient, db_session: AsyncSession
):
    """A signed-out tab must not keep a future expiry to act on."""
    await _seed(db_session)
    await _login(test_client)
    assert test_client.cookies.get(ACCESS_EXPIRY_COOKIE_NAME)

    logout = await test_client.post("/api/v1/auth/logout")
    assert logout.status_code == 200
    assert not test_client.cookies.get(ACCESS_EXPIRY_COOKIE_NAME)
