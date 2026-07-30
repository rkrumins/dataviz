"""Session lifecycle: the guarantees a browser depends on to stop asking.

Three properties, each of which was broken in a way that produced a
user-visible symptom nobody could reproduce on demand:

1. **A rejected refresh must evict the cookies it rejected.** Otherwise the
   browser re-presents a dead ``nx_refresh`` on every single page load for
   the full seven days of its ``max-age``, and each load 401s, silently
   refreshes, 401s again, and announces a lost session. That is the
   "permanent login loop".

   The defect was subtle: the endpoint called ``clear_session_cookies``
   on the injected ``Response`` and *then* raised ``HTTPException``.
   FastAPI merges that response's headers into the reply only on the
   success path — when the endpoint raises, Starlette builds a fresh
   ``JSONResponse`` and every ``Set-Cookie`` is discarded. The code read
   exactly right and did nothing.

2. **Signing out must kill the access token, not just the refresh
   family.** Clearing the cookie removes it from *this* browser; a copy
   captured anywhere else stays valid until ``exp``.

3. **"Sign out everywhere" must not be defeated by a token that cannot
   prove when it was minted.** The cutoff comparison failed open on a
   missing mint claim, so a token carrying neither ``mat`` nor ``iat``
   walked straight through it.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.auth.password import hash_password
from backend.app.db.models import Base
from backend.app.db.repositories import user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.auth_service.cookies import (
    ACCESS_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
)
from backend.auth_service.service import LocalIdentityService, _refresh_predates_cutoff


_PASSWORD = "C0mpl3x!Passw0rd#"


# ── helpers ──────────────────────────────────────────────────────────


def evicted_cookie_names(response) -> set[str]:
    """Names the response tells the browser to drop.

    A deletion is a ``Set-Cookie`` with ``Max-Age=0`` (what Starlette's
    ``delete_cookie`` emits). Read off the raw headers rather than
    ``response.cookies``, because httpx applies deletions to its jar and
    then has nothing left to report — which would make this assertion
    pass against a response carrying no headers at all.
    """
    names: set[str] = set()
    for raw in response.headers.get_list("set-cookie"):
        head, _, attrs = raw.partition(";")
        name = head.split("=", 1)[0].strip()
        if "max-age=0" in attrs.lower():
            names.add(name)
    return names


async def _seed(db_session, email: str) -> str:
    user = await user_repo.create_user(
        db_session,
        email=email,
        password_hash=hash_password(_PASSWORD),
        first_name="Session",
        last_name="Tester",
        status="active",
    )
    await user_repo.assign_role(db_session, user.id, "super_admin")
    await db_session.commit()
    return user.id


async def _login(client: AsyncClient, email: str):
    resp = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    return resp


_STUB_SID = "sess_lifecycle_test"


async def _stub_claims_resolver(_session, _user_id, **_kwargs) -> dict:
    """The minimum shape ``_issue_tokens`` embeds as the ``sid`` claim."""
    return {"sid": _STUB_SID, "global": [], "ws": {}}


# ── 1. a rejected refresh evicts the cookies it rejected ─────────────

_SESSION_COOKIES = {ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME}


async def test_refresh_without_cookie_evicts_session_cookies(
    test_client: AsyncClient,
):
    """The no-cookie 401. Nothing to rotate, so say so and clean up.

    A browser can reach this with a live ``nx_access``/``nx_csrf`` pair and
    a refresh cookie that has aged out — leaving the other two behind
    keeps the session half-alive.
    """
    test_client.cookies.delete(REFRESH_COOKIE_NAME)
    resp = await test_client.post("/api/v1/auth/refresh")

    assert resp.status_code == 401
    assert evicted_cookie_names(resp) == _SESSION_COOKIES


async def test_refresh_with_garbage_token_evicts_session_cookies(
    test_client: AsyncClient,
):
    """An undecodable refresh cookie is the clearest case there is.

    It will never become valid, so re-presenting it forever is pure loop.
    """
    resp = await test_client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: "not-a-jwt-at-all"},
    )

    assert resp.status_code == 401
    assert evicted_cookie_names(resp) == _SESSION_COOKIES


async def test_refresh_on_revoked_family_evicts_session_cookies(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """Reuse detection killed the family — the cookie must go with it.

    This is the path a real stolen-chain replay takes, and the one where
    leaving the cookie in place is worst: every subsequent page load
    re-presents a credential the server has already condemned.
    """
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ROTATION_GRACE_SECONDS", 0,
    )
    await _seed(db_session, "revoked-family@example.com")
    login = await _login(test_client, "revoked-family@example.com")
    captured = login.cookies.get(REFRESH_COOKIE_NAME)

    first = await test_client.post(
        "/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: captured},
    )
    assert first.status_code == 200

    replay = await test_client.post(
        "/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: captured},
    )
    assert replay.status_code == 401
    assert evicted_cookie_names(replay) == _SESSION_COOKIES


async def test_successful_refresh_does_not_evict_anything(
    test_client: AsyncClient, db_session,
):
    """The counterweight: rotation must still *set* cookies, not drop them.

    Without this, "always clear on the way out" would look like a fix and
    log everybody out on the happy path.
    """
    await _seed(db_session, "happy-rotation@example.com")
    await _login(test_client, "happy-rotation@example.com")

    resp = await test_client.post("/api/v1/auth/refresh")

    assert resp.status_code == 200
    assert evicted_cookie_names(resp) == set()
    assert resp.cookies.get(REFRESH_COOKIE_NAME)


# ── 2. signing out kills the access token too ────────────────────────


@pytest_asyncio.fixture()
async def real_engine(tmp_path):
    """File-backed SQLite so sessions get independent connections.

    Same reasoning as ``test_auth_revocation_durability.py``: the shared
    in-memory engine hands every session the same connection, so anything
    that depends on a real transaction boundary is invisible there.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'session.db'}")
    agg_path = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _attach_aggregation_schema(dbapi_conn, _record):
        dbapi_conn.execute(f"ATTACH DATABASE '{agg_path}' AS aggregation")
        dbapi_conn.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _emit_begin(conn):
        conn.exec_driver_sql("BEGIN")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture()
async def session_factory(real_engine):
    maker = async_sessionmaker(bind=real_engine, expire_on_commit=False)

    @asynccontextmanager
    async def factory():
        session = maker()
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

    return factory


async def test_logout_revokes_the_access_session(session_factory):
    """Clearing the cookie is not revocation.

    ``logout`` revoked the refresh family, which stops the *next*
    rotation. The access token it was issued alongside stayed valid for
    its full remaining life, so a copy taken anywhere other than this
    browser kept working after the user believed they had signed out.
    """
    revoked: list[str] = []

    async def record_sid(sid: str) -> None:
        revoked.append(sid)

    svc = LocalIdentityService(
        session_factory=session_factory,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
        # The sid is minted by the claims resolver, so a service wired
        # without one issues tokens with nothing to revoke. Production
        # always has it (``_resolve_claims`` in app/main.py).
        claims_resolver=_stub_claims_resolver,
        session_revoker=record_sid,
    )

    async with session_factory() as session:
        user = await user_repo.create_user(
            session,
            email="signout@example.com",
            password_hash=hash_password(_PASSWORD),
            first_name="Sign",
            last_name="Out",
            status="active",
        )
        await user_repo.assign_role(session, user.id, "super_admin")

    _, tokens = await svc.login("signout@example.com", _PASSWORD)

    await svc.logout(tokens.refresh_token, access_token=tokens.access_token)

    from backend.auth_service.core.tokens import decode_token
    expected_sid = decode_token(tokens.access_token).get("sid")
    assert expected_sid, "login should mint a sid to revoke"
    assert revoked == [expected_sid]


async def test_logout_without_access_token_still_revokes_family(session_factory):
    """The access cookie can be gone already — expired, or never sent.

    Logout is idempotent by contract and callable by a browser holding
    only a refresh cookie, so a missing access token must not turn it
    into an error or skip the family revocation.
    """
    svc = LocalIdentityService(
        session_factory=session_factory,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
        session_revoker=None,
    )

    async with session_factory() as session:
        user = await user_repo.create_user(
            session,
            email="no-access@example.com",
            password_hash=hash_password(_PASSWORD),
            first_name="No",
            last_name="Access",
            status="active",
        )
        await user_repo.assign_role(session, user.id, "super_admin")

    _, tokens = await svc.login("no-access@example.com", _PASSWORD)
    await svc.logout(tokens.refresh_token)

    from backend.auth_service.service import InvalidRefreshToken
    with pytest.raises(InvalidRefreshToken):
        await svc.refresh(tokens.refresh_token)


# ── 3. session state is resolved from the DB, not re-read off the token ──

_FAKE_USER_ID = "usr_test000000"  # conftest's ``test_client`` identity


@asynccontextmanager
async def _token_minted_before_the_grant():
    """Pin the caller's JWT claims to "no permissions at all".

    The fixture's default claims carry ``system:admin``, which is the one
    value that makes every comparison here vacuous. This models the real
    situation instead: a token minted before an admin changed something.
    """
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.main import app
    from backend.app.services.permission_service import PermissionClaims

    previous = app.dependency_overrides.get(get_permission_claims)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", global_perms=(), ws_perms={},
    )
    try:
        yield
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_permission_claims, None)
        else:
            app.dependency_overrides[get_permission_claims] = previous


async def test_session_sees_a_grant_without_a_token_rotation(
    test_client: AsyncClient, db_session,
):
    """The property the old design could not have.

    ``/me/permissions`` re-reads the claims out of the access token, so
    polling it after a grant returns the stale answer forever — with a
    200, which is why nothing ever looked broken. Resolving from the
    database means one poll picks the change up, and this test is the
    proof: same session, same token, no rotation anywhere in it.
    """
    from backend.app.db.repositories import binding_repo

    async with _token_minted_before_the_grant():
        before = await test_client.get("/api/v1/me/session")
        assert before.status_code == 200, before.text
        assert before.json()["permissions"]["global"] == []
        assert before.json()["staleClaims"] is False

        await binding_repo.create_binding(
            db_session,
            subject_type="user", subject_id=_FAKE_USER_ID,
            role_name="super_admin", scope_type="global",
        )
        await db_session.commit()

        after = await test_client.get("/api/v1/me/session")
        assert after.status_code == 200, after.text
        assert "system:admin" in after.json()["permissions"]["global"]

        # And the token is now behind the database, which the client has
        # to be told — it is what makes it rotate instead of offering
        # controls that ``requires()`` will still refuse.
        assert after.json()["staleClaims"] is True

        # The superseded endpoint demonstrates the defect it was retired
        # for: same request, same moment, still the pre-grant answer.
        legacy = await test_client.get("/api/v1/me/permissions")
        assert legacy.status_code == 200
        assert legacy.json()["global"] == []


async def test_session_reports_matching_claims_as_fresh(
    test_client: AsyncClient, db_session,
):
    """``staleClaims`` must not fire on a session nobody touched.

    A false positive costs a token rotation on every poll — a self-
    inflicted rotation storm. Ordering is the trap: ``resolve`` builds
    buckets from query results and the token carries whatever order it was
    serialised in, so comparing them raw reports differences that are not
    there.
    """
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.db.repositories import binding_repo
    from backend.app.main import app
    from backend.app.services.permission_service import PermissionClaims

    await binding_repo.create_binding(
        db_session,
        subject_type="user", subject_id=_FAKE_USER_ID,
        role_name="workspace_admin", scope_type="workspace",
        scope_id="ws_alpha",
    )
    await binding_repo.create_binding(
        db_session,
        subject_type="user", subject_id=_FAKE_USER_ID,
        role_name="workspace_viewer", scope_type="workspace",
        scope_id="ws_beta",
    )
    await db_session.commit()

    from backend.app.services.permission_service import resolve
    truth = await resolve(db_session, _FAKE_USER_ID, sid="sess_test")

    # Hand the endpoint the same claims back, deliberately reversed at
    # every level, as a serialisation-order difference would.
    reversed_ws = {
        ws: tuple(reversed(sorted(perms)))
        for ws, perms in reversed(list(truth.ws_perms.items()))
    }
    previous = app.dependency_overrides.get(get_permission_claims)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test",
        global_perms=tuple(reversed(sorted(truth.global_perms))),
        ws_perms=reversed_ws,
    )
    try:
        resp = await test_client.get("/api/v1/me/session")
        assert resp.status_code == 200, resp.text
        assert resp.json()["staleClaims"] is False
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_permission_claims, None)
        else:
            app.dependency_overrides[get_permission_claims] = previous


async def test_session_returns_the_same_user_shape_as_auth_me(
    test_client: AsyncClient, db_session,
):
    """One user DTO, or the shell renders differently depending on
    which call happened to answer first.

    ``/me/session`` exists to replace the ``/auth/me`` + ``/me/permissions``
    pair at boot, so its ``user`` has to be the identical object — not a
    near-copy that drops ``avatarId`` or spells ``mustChangePassword``
    differently.
    """
    await _seed(db_session, "same-shape@example.com")
    await _login(test_client, "same-shape@example.com")

    auth_me = await test_client.get("/api/v1/auth/me")
    session = await test_client.get("/api/v1/me/session")
    assert auth_me.status_code == 200 and session.status_code == 200

    assert session.json()["user"].keys() == auth_me.json()["user"].keys()


# ── 4. the cutoff is not defeated by a missing mint claim ────────────


def test_cutoff_refuses_a_token_that_cannot_date_itself():
    """"I don't know when I was minted" must not beat "sign out everywhere".

    ``mint_ms`` falls back from ``mat`` to ``iat`` to ``0``. Failing open
    on ``0`` is right when there is no cutoff to enforce — but once an
    operator has stamped one, a token that cannot place itself relative
    to it is the one case where believing it costs the most.
    """
    assert _refresh_predates_cutoff(0, "2026-07-30T12:00:00+00:00") is True


def test_cutoff_ignores_an_undateable_token_when_nobody_revoked():
    """No cutoff, no verdict. This is the common case and must stay open."""
    assert _refresh_predates_cutoff(0, None) is False


def test_cutoff_still_ignores_an_unparseable_stamp():
    """A malformed column must not lock an account out of its own refresh.

    Note the ordering this pins: an unreadable cutoff wins over an
    undateable token. Judging the token first would make a malformed
    column refuse every token that cannot date itself — turning the
    fail-closed rule above into the very lockout the fail-open rule
    exists to prevent.
    """
    assert _refresh_predates_cutoff(0, "not-a-timestamp") is False
    assert _refresh_predates_cutoff(1_700_000_000_000, "not-a-timestamp") is False
