"""Per-account rate limiting.

The per-IP limit is a flood guard sized so a whole tenant behind one
egress address never reaches it — which by construction makes it useless
against a password spray. These tests cover the control that isn't:
one keyed on the account under attack, so it holds however many
addresses the attempts arrive from.

The distinction the tests exist to pin is that throttling one account
must not throttle anybody else. A shared bucket would "pass" a naive
lockout test while locking out the tenant.
"""
from __future__ import annotations

import pytest

from backend.auth_service.ratelimit import AccountRateLimiter


_LIMIT = "3 per 15 minutes"


@pytest.fixture()
def limiter() -> AccountRateLimiter:
    """A limiter per test — in-memory, so tests never share buckets."""
    return AccountRateLimiter()


async def _exhaust(limiter: AccountRateLimiter, email: str) -> None:
    for _ in range(3):
        assert await limiter.check("login", email, _LIMIT)
        await limiter.record("login", email, _LIMIT)


async def test_repeated_failures_are_refused(limiter):
    await _exhaust(limiter, "target@example.com")
    assert not await limiter.check("login", "target@example.com", _LIMIT)


async def test_throttling_one_account_leaves_others_alone(limiter):
    """The property that separates this from the per-IP limit.

    A spray against one mailbox must not lock out the colleague at the
    next desk — who, behind a NAT, shares every address-based bucket
    with the attacker's traffic.
    """
    await _exhaust(limiter, "target@example.com")
    assert not await limiter.check("login", "target@example.com", _LIMIT)
    assert await limiter.check("login", "bystander@example.com", _LIMIT)


async def test_a_success_clears_the_count(limiter):
    """Only failures accumulate.

    Someone who mistypes twice and then signs in correctly must not
    carry those failures into their next session, or a clumsy typist
    would eventually lock themselves out of an account they own.
    """
    for _ in range(2):
        await limiter.record("login", "typo@example.com", _LIMIT)
    await limiter.reset("login", "typo@example.com", _LIMIT)

    for _ in range(3):
        assert await limiter.check("login", "typo@example.com", _LIMIT)
        await limiter.record("login", "typo@example.com", _LIMIT)


async def test_reset_uses_the_key_the_limiter_actually_wrote(limiter):
    """Guards a silent no-op.

    The storage key is derived from the parsed limit, not the bucket
    name, so clearing the bare bucket does nothing — and does nothing
    *quietly*, which reads exactly like a working reset right up until
    a user is refused after signing in successfully.
    """
    await _exhaust(limiter, "key@example.com")
    assert not await limiter.check("login", "key@example.com", _LIMIT)
    await limiter.reset("login", "key@example.com", _LIMIT)
    assert await limiter.check("login", "key@example.com", _LIMIT)


async def test_the_bucket_is_normalised(limiter):
    """Case and surrounding whitespace must not mint a fresh allowance."""
    await _exhaust(limiter, "Case@Example.com")
    assert not await limiter.check("login", "  case@example.COM  ", _LIMIT)


async def test_scopes_do_not_share_a_bucket(limiter):
    """Exhausting sign-in attempts must not also block a password reset."""
    await _exhaust(limiter, "scoped@example.com")
    assert not await limiter.check("login", "scoped@example.com", _LIMIT)
    assert await limiter.check("password_reset", "scoped@example.com", _LIMIT)


async def test_retry_after_is_a_usable_number(limiter):
    await _exhaust(limiter, "retry@example.com")
    seconds = await limiter.retry_after_seconds(
        "login", "retry@example.com", _LIMIT,
    )
    assert 0 < seconds <= 15 * 60


async def test_a_broken_store_fails_open(limiter, monkeypatch):
    """A limiter that cannot reach Redis must not become a login outage.

    Failing closed here would turn a cache blip into "nobody in the
    company can sign in", which is a worse outcome than the window of
    extra attempts that failing open costs — argon2's own cost and the
    per-IP limit both still apply.
    """
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("redis is gone")

    monkeypatch.setattr(limiter._limiter, "test", _boom)
    assert await limiter.check("login", "outage@example.com", _LIMIT)


async def test_no_storage_uri_still_works():
    """The in-memory fallback must function, not error.

    Same posture as the request limiter: dev and test run without Redis.
    """
    fallback = AccountRateLimiter(storage_uri=None)
    assert await fallback.check("login", "nostore@example.com", _LIMIT)


def test_a_sync_redis_uri_is_mapped_to_the_async_backend():
    """``limits`` picks the backend from an ``async+`` scheme prefix.

    The request limiter's URI is the sync form, so reusing it verbatim
    would hand the async strategy a sync storage it cannot await.
    """
    from backend.auth_service.ratelimit import _as_async_uri

    assert _as_async_uri("redis://redis:6379/1") == "async+redis://redis:6379/1"
    assert _as_async_uri("async+redis://r:6379/1") == "async+redis://r:6379/1"
    assert _as_async_uri(None) == "async+memory://"
    assert _as_async_uri("") == "async+memory://"


# ── End to end, through the login endpoint ───────────────────────────

async def test_login_endpoint_throttles_one_account_not_the_tenant(
    test_client, db_session, monkeypatch,
):
    """The whole point, exercised through the route.

    Two accounts, one attacker. After the spray exhausts the target's
    allowance the target is refused with 429 — and the bystander, who
    shares every address-based bucket with the attacker, still signs in.
    """
    from backend.app.auth.password import hash_password
    from backend.app.db.repositories import user_repo
    from backend.auth_service import ratelimit as ratelimit_mod

    password = "C0mpl3x!Passw0rd#"
    for email in ("target@example.com", "bystander@example.com"):
        user = await user_repo.create_user(
            db_session, email=email, password_hash=hash_password(password),
            first_name="A", last_name="B", status="active",
        )
        await user_repo.assign_role(db_session, user.id, "super_admin")
    await db_session.commit()

    # Fresh limiter with a small window so the test states its own terms.
    monkeypatch.setattr(
        ratelimit_mod, "_account_limiter", AccountRateLimiter(),
    )
    monkeypatch.setattr(
        "backend.auth_service.api.router.RATELIMIT_LOGIN_PER_ACCOUNT",
        "3 per 15 minutes",
    )

    for _ in range(3):
        bad = await test_client.post(
            "/api/v1/auth/login",
            json={"email": "target@example.com", "password": "wrong"},
        )
        assert bad.status_code == 401

    throttled = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "target@example.com", "password": password},
    )
    assert throttled.status_code == 429, (
        "the correct password should not get past an exhausted account budget"
    )
    assert throttled.headers.get("Retry-After")

    bystander = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "bystander@example.com", "password": password},
    )
    assert bystander.status_code == 200, (
        "throttling one account must not lock out everyone sharing the IP"
    )


async def test_login_success_clears_the_account_budget(
    test_client, db_session, monkeypatch,
):
    """A user who mistypes then gets it right starts clean."""
    from backend.app.auth.password import hash_password
    from backend.app.db.repositories import user_repo
    from backend.auth_service import ratelimit as ratelimit_mod

    password = "C0mpl3x!Passw0rd#"
    user = await user_repo.create_user(
        db_session, email="typo@example.com",
        password_hash=hash_password(password),
        first_name="A", last_name="B", status="active",
    )
    await user_repo.assign_role(db_session, user.id, "super_admin")
    await db_session.commit()

    monkeypatch.setattr(ratelimit_mod, "_account_limiter", AccountRateLimiter())
    monkeypatch.setattr(
        "backend.auth_service.api.router.RATELIMIT_LOGIN_PER_ACCOUNT",
        "3 per 15 minutes",
    )

    for _ in range(2):
        await test_client.post(
            "/api/v1/auth/login",
            json={"email": "typo@example.com", "password": "wrong"},
        )
    ok = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "typo@example.com", "password": password},
    )
    assert ok.status_code == 200

    # Budget reset, so three more failures are available rather than one.
    for _ in range(3):
        again = await test_client.post(
            "/api/v1/auth/login",
            json={"email": "typo@example.com", "password": "wrong"},
        )
        assert again.status_code == 401
