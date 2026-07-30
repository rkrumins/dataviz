"""A heavily-bound user must be able to sign in.

This is the failure the claim split exists to fix, exercised through the
real endpoint rather than against the mint in isolation — because the
symptom was never in the mint. ``/auth/login`` answered 200, the
``Set-Cookie`` went out, and the *browser* discarded it for being over
4096 bytes. Server-side everything looked perfect, which is why nothing
caught it: only a client measuring the cookie can see the failure.

So these tests measure the cookie the way a browser does, and check the
session actually works afterwards.
"""
from __future__ import annotations

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

import pytest

from backend.app.auth.password import hash_password
from backend.app.db.repositories import binding_repo, user_repo
from backend.app.services import permission_service
from backend.auth_service.cookies import (
    ACCESS_COOKIE_NAME,
    MAX_COOKIE_BYTES,
    REFRESH_COOKIE_NAME,
    access_cookie_bytes,
)
from backend.auth_service.core.tokens import create_access_token

_PASSWORD = "C0mpl3x!Passw0rd#"

#: Bindings to seed. Chosen to exceed 4096 bytes when embedded, but the
#: exact number that does depends on how many workspace-category
#: permissions the seeded role expands to — which is DB data, not a
#: constant. So the seeder *verifies* the premise rather than assuming it;
#: see ``_seed_wide_access_user``. Raise this if that check ever fires.
_WIDE = 150


@pytest.fixture()
def real_claims(test_client, db_session):
    """Make ``/auth/login`` actually resolve permission claims.

    ``conftest``'s ``test_client`` builds ``LocalIdentityService`` without a
    ``claims_resolver``, so in every other test in this suite login mints a
    token carrying **no permission claims at all**. That is exactly why the
    cookie ceiling reached production: no test had ever exercised
    claims-in-token, so no test could measure a cookie that grew with them.
    It is the same shape of blindness as the transaction-semantics gap
    documented on the ``test_client`` fixture itself.

    This mirrors ``_resolve_claims`` in ``app/main.py`` — resolve, record
    the session (so the store can answer for a slim token), return the JWT
    half — so what runs here is the production path rather than an
    approximation of it.
    """
    from backend.app.main import app
    from backend.app.services.revocation_service import get_revocation_service

    svc = app.state.identity_service

    async def _resolve(session, user_id: str) -> dict:
        claims = await permission_service.resolve(session, user_id)
        try:
            await get_revocation_service().record_session(
                user_id, claims.sid, claims=claims.to_session_dict(),
            )
        except Exception:  # noqa: BLE001 — best-effort, as in production
            pass
        return claims.to_jwt_dict()

    previous = svc._claims_resolver
    svc._claims_resolver = _resolve
    yield
    svc._claims_resolver = previous


def _cookie_bytes(resp, name: str) -> int:
    """Name + value, the metric browsers apply the 4096 limit to."""
    for header in resp.headers.get_list("set-cookie"):
        if header.startswith(f"{name}="):
            value = header.split(";", 1)[0][len(name) + 1:]
            return len(name) + 1 + len(value)
    raise AssertionError(f"no Set-Cookie for {name}")


async def _seed_wide_access_user(
    db_session: AsyncSession, email: str, n_workspaces: int = _WIDE,
) -> str:
    """A user bound into *n_workspaces*, verified to actually be so.

    Workspace-scoped role bindings are what ``permission_service.resolve``
    turns into ``ws_perms``, so they are what makes the claim set — and
    therefore the cookie — large. Deliberately NOT wrapped in a
    try/except: an earlier version of this swallowed a signature mismatch
    and silently seeded zero workspaces, so the tests passed while
    proving nothing. The assertion below is what makes that impossible.
    """
    user = await user_repo.create_user(
        db_session, email=email, password_hash=hash_password(_PASSWORD),
        first_name="Wide", last_name="Access", status="active",
    )
    for i in range(n_workspaces):
        await binding_repo.create_binding(
            db_session,
            subject_type="user",
            subject_id=user.id,
            role_name="workspace_admin",
            scope_type="workspace",
            scope_id=f"ws_{i:012x}",
        )
    await db_session.commit()

    resolved = await permission_service.resolve(db_session, user.id)
    if len(resolved.ws_perms) < n_workspaces:
        pytest.fail(
            f"seed produced {len(resolved.ws_perms)} workspace grants, "
            f"wanted {n_workspaces} — these tests would pass vacuously"
        )

    # Prove the premise: embedding these grants must actually breach the
    # limit, or every assertion below passes for free.
    #
    # This is not paranoia. The first version of this file seeded 40
    # bindings on the assumption that ~18 was the cliff, but the cliff
    # depends on how many workspace-category permissions the role expands
    # to — which is seed data. At this catalogue's expansion, 40 bindings
    # came to 2.2 KB, comfortably legal, and the whole file passed with
    # the fix reverted. Asserting the premise is what makes the rest mean
    # anything.
    inline = {
        **resolved.to_jwt_dict(),
        # The pre-split layout, spelled out: ``to_jwt_dict`` cannot produce
        # it any more, which is the whole point of the contract.
        "ws": {ws: list(perms) for ws, perms in resolved.ws_perms.items()},
    }
    would_be = create_access_token(user.id, email, "user", extra=inline)
    unshed = access_cookie_bytes(would_be)
    if unshed <= MAX_COOKIE_BYTES:
        pytest.fail(
            f"{n_workspaces} bindings embed to only {unshed}B, under the "
            f"{MAX_COOKIE_BYTES}B limit — this seed cannot reproduce the "
            "failure, so raise _WIDE"
        )
    return user.id


async def test_login_cookie_stays_within_the_browser_limit(
    test_client: AsyncClient, db_session: AsyncSession, real_claims,
):
    """The headline: a wide-access account gets a storable cookie.

    Measured off the wire, not off the token, because the limit applies to
    the cookie and the discarding is done by the client.
    """
    await _seed_wide_access_user(db_session, "wide@example.com")

    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "wide@example.com", "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text

    size = _cookie_bytes(resp, ACCESS_COOKIE_NAME)
    assert size <= MAX_COOKIE_BYTES, (
        f"access cookie is {size}B; a browser would discard it silently "
        "and the user would bounce straight back to /login"
    )
    # The other session cookies are small and fixed, but assert the one
    # that matters is present — a discarded access cookie and an absent
    # one are the same thing from the client's side.
    assert resp.cookies.get(ACCESS_COOKIE_NAME)
    assert resp.cookies.get(REFRESH_COOKIE_NAME)


async def test_a_wide_access_session_actually_works(
    test_client: AsyncClient, db_session: AsyncSession, real_claims,
):
    """A storable cookie is necessary but not sufficient.

    If the grants were shed from the token and the store could not answer
    for them, login would succeed and every workspace route would 403 —
    trading a silent sign-out for a silent loss of access. So drive an
    authenticated request and confirm the identity survived the round
    trip.
    """
    await _seed_wide_access_user(db_session, "wide2@example.com")

    login = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "wide2@example.com", "password": _PASSWORD},
    )
    assert login.status_code == 200, login.text

    me = await test_client.get("/api/v1/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["user"]["email"] == "wide2@example.com"


async def test_refresh_keeps_the_cookie_within_the_limit(
    test_client: AsyncClient, db_session: AsyncSession, real_claims,
):
    """Rotation re-resolves claims, so it can re-cross the limit.

    A login that fits followed by a rotation that does not would put the
    user in the worst position of all: signed in, working, then silently
    signed out at the first renewal with no way back.
    """
    await _seed_wide_access_user(db_session, "wide3@example.com")
    login = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "wide3@example.com", "password": _PASSWORD},
    )
    assert login.status_code == 200

    refreshed = await test_client.post("/api/v1/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    size = _cookie_bytes(refreshed, ACCESS_COOKIE_NAME)
    assert size <= MAX_COOKIE_BYTES, (
        f"rotation produced a {size}B cookie — the session would die at "
        "its first renewal"
    )
