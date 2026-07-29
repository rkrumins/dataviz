"""``/auth/refresh`` must be bucketed per session, not per address.

Keying this endpoint on the client address is what turned a rate limit
into a logout. Behind a proxy ``get_remote_address`` returns the ingress
address, so every user in the deployment shared one 30/minute bucket;
users in a NAT'd office shared one regardless. Rotations cluster —
everyone who signed in at 09:00 rotates together — so a synchronised
herd hit the shared window, got a 429, and the SPA read any non-OK
refresh as "session gone".

The ``fam`` claim identifies one browser session, which is what the
limit is meant to protect, and survives both NAT and missing forwarding
headers.
"""
from __future__ import annotations

from starlette.requests import Request

from backend.auth_service.api.router import (
    _refresh_family_key,
    _resolve_ratelimit_storage_uri,
)
from backend.auth_service.cookies import REFRESH_COOKIE_NAME
from backend.auth_service.core.tokens import create_refresh_token


def _request(cookie: str | None, client_ip: str = "10.0.0.1") -> Request:
    headers = []
    if cookie is not None:
        headers.append(
            (b"cookie", f"{REFRESH_COOKIE_NAME}={cookie}".encode()),
        )
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/v1/auth/refresh",
        "headers": headers,
        "client": (client_ip, 1234),
        "scheme": "http",
        "server": ("testserver", 80),
        "query_string": b"",
    })


def test_two_sessions_behind_one_address_get_separate_buckets():
    """The whole point: one office must not share one refresh budget."""
    alice, _ = create_refresh_token(user_id="u_alice")
    bob, _ = create_refresh_token(user_id="u_bob")

    shared_ip = "203.0.113.7"
    assert (
        _refresh_family_key(_request(alice, shared_ip))
        != _refresh_family_key(_request(bob, shared_ip))
    )


def test_one_session_keeps_its_bucket_across_addresses():
    """A laptop moving from office wifi to tethering is still one session."""
    token, claims = create_refresh_token(user_id="u_roaming")
    key_a = _refresh_family_key(_request(token, "203.0.113.7"))
    key_b = _refresh_family_key(_request(token, "198.51.100.2"))
    assert key_a == key_b == f"fam:{claims.family_id}"


def test_rotated_tokens_in_one_family_share_a_bucket():
    """Rotation must not hand a session a fresh budget every 30 seconds."""
    _, first = create_refresh_token(user_id="u_rot")
    rotated, second = create_refresh_token(
        user_id="u_rot", family_id=first.family_id,
    )
    assert second.jti != first.jti
    assert _refresh_family_key(_request(rotated)) == f"fam:{first.family_id}"


def test_expired_token_still_names_its_family():
    """An expired refresh is exactly when the bucket matters.

    Falling back to the address here would pile every expired session in
    the deployment back into the one bucket this change exists to empty.
    """
    token, claims = create_refresh_token(user_id="u_expired")
    # Mint one that expired an hour ago.
    stale, _ = create_refresh_token(
        user_id="u_expired",
        family_id=claims.family_id,
        expires_at_epoch=claims.exp - 8 * 24 * 3600,
    )
    assert _refresh_family_key(_request(stale)) == f"fam:{claims.family_id}"


def test_unusable_cookies_fall_back_to_the_address():
    """No cookie, or one we did not sign, cannot name a session."""
    assert _refresh_family_key(_request(None)) == "10.0.0.1"
    assert _refresh_family_key(_request("not-a-jwt")) == "10.0.0.1"


def test_a_forged_family_cannot_choose_its_bucket():
    """The key is read from a verified signature, not from the wire.

    Otherwise a caller could mint themselves a fresh bucket per request
    and the limit would be decorative.
    """
    import jwt as pyjwt

    forged = pyjwt.encode(
        {"sub": "u", "jti": "x", "fam": "attacker-chosen", "aud": "x", "iss": "x"},
        "not-the-signing-key",
        algorithm="HS256",
    )
    assert _refresh_family_key(_request(forged)) == "10.0.0.1"


# ── Storage URI resolution ───────────────────────────────────────────

def _resolve(monkeypatch, **env):
    """Resolve the storage URI under *env*.

    Calls the helper directly rather than reloading the module. A reload
    would rebuild the module-level ``limiter``, and both this router and
    ``endpoints/auth.py`` are asserted elsewhere to share one instance —
    so it would leave a different object behind for whatever ran next.
    """
    for key in ("RATELIMIT_STORAGE_URI", "REDIS_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return _resolve_ratelimit_storage_uri()


def test_blank_redis_url_falls_back_to_memory(monkeypatch):
    """``REDIS_URL: ""`` must not become ``storage_uri=""``.

    The production overlay sets it empty on purpose, expecting the
    Secret to supply the real value. When the Secret does not, an empty
    string would reach the limiter as a malformed storage URI instead of
    the in-memory fallback — a config shape that exists in exactly one
    environment, which is the worst place to discover it.
    """
    assert _resolve(monkeypatch, REDIS_URL="") is None


def test_unset_is_the_same_as_blank(monkeypatch):
    assert _resolve(monkeypatch) is None


def test_redis_url_is_used_when_set(monkeypatch):
    assert _resolve(
        monkeypatch, REDIS_URL="redis://redis:6379/1",
    ) == "redis://redis:6379/1"


def test_explicit_storage_uri_wins_over_redis_url(monkeypatch):
    assert _resolve(
        monkeypatch,
        RATELIMIT_STORAGE_URI="redis://limits:6379/2",
        REDIS_URL="redis://redis:6379/0",
    ) == "redis://limits:6379/2"


# ── Where the counters actually live ─────────────────────────────────

def _clear_redis_env(monkeypatch):
    for key in (
        "RATELIMIT_STORAGE_URI", "REDIS_URL",
        "REDIS_STREAMS_HOST", "REDIS_STREAMS_PORT", "REDIS_STREAMS_DB",
        "REDIS_STREAMS_PASSWORD", "REDIS_STREAMS_USERNAME",
        "REDIS_STREAMS_TLS_ENABLED", "REDIS_STREAMS_TLS_CA_CERTS",
    ):
        monkeypatch.delenv(key, raising=False)


def test_production_role_prefixed_vars_resolve(monkeypatch):
    """The case that made this necessary.

    Production deletes the in-cluster redis Service and addresses
    Memorystore through role-prefixed vars with its own AUTH password
    and TLS CA — while deliberately blanking REDIS_URL so no stale
    coordinate survives the overlay merge. A limiter reading REDIS_URL
    finds nothing there and silently reverts to per-worker counting, in
    the one environment that most needs shared counters.
    """
    from backend.auth_service.ratelimit import resolve_storage

    _clear_redis_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "")            # as the overlay leaves it
    monkeypatch.setenv("REDIS_STREAMS_HOST", "10.1.2.3")
    monkeypatch.setenv("REDIS_STREAMS_PORT", "6379")
    monkeypatch.setenv("REDIS_STREAMS_DB", "0")
    monkeypatch.setenv("REDIS_STREAMS_PASSWORD", "s3cret")
    monkeypatch.setenv("REDIS_STREAMS_TLS_ENABLED", "true")

    uri, options = resolve_storage()
    assert uri == "rediss://10.1.2.3:6379/0", "TLS must select the rediss scheme"
    assert options["password"] == "s3cret", "AUTH password must be carried"


def test_nothing_configured_means_in_memory(monkeypatch):
    """A defaulted host is not a configured one.

    The central resolver always answers, falling back to localhost. Only
    its provenance map distinguishes "somebody configured localhost"
    from "nobody configured anything" — and treating the default as real
    points tests and Redis-less dev at a dead port, paying a refused
    connection per request to reach the answer memory gives for free.
    """
    from backend.auth_service.ratelimit import resolve_storage

    _clear_redis_env(monkeypatch)
    assert resolve_storage() == (None, {})


def test_credentials_are_never_logged(monkeypatch):
    """The startup line names the backend; it must not name the password."""
    from backend.auth_service.ratelimit import describe_storage

    assert "hunter2" not in describe_storage("rediss://user:hunter2@10.1.2.3:6379/0")
    assert describe_storage(None).startswith("in-memory")


def test_an_unreachable_store_does_not_break_the_endpoint():
    """swallow_errors is not enough, and the name suggests otherwise.

    A refused connection surfaces from the storage layer during ``incr``
    and escapes as a 500, so an unreachable Redis did not degrade the
    limit — it broke every endpoint carrying one, login included.
    """
    from backend.auth_service.api.router import limiter

    assert limiter._in_memory_fallback_enabled, (
        "an unreachable rate-limit store must degrade to local counters, "
        "not 500 the login endpoint"
    )


def test_the_async_redis_driver_is_a_declared_dependency():
    """The failure mode this whole file cannot otherwise see.

    ``limits`` ships support for several Redis clients and picks one by
    default. That default is ``coredis``, which is not in
    ``requirements.txt`` — so the async storage constructed fine in
    every environment without Redis (memory backend, driver never
    touched) and raised ``ConfigurationError`` in the one with Redis,
    turning every login into a 500.

    Asserting the driver against the requirements file catches the next
    version of this: a library defaulting to an optional extra we do not
    install, invisible until something builds the object for real.
    """
    import re
    from pathlib import Path

    from limits.aio.storage import RedisStorage

    from backend.auth_service.ratelimit import _ASYNC_REDIS_IMPLEMENTATION

    # limits names its implementations after the client library, except
    # redis-py, whose package is ``redis``.
    package = {"redispy": "redis"}.get(
        _ASYNC_REDIS_IMPLEMENTATION, _ASYNC_REDIS_IMPLEMENTATION,
    )
    assert package in RedisStorage.DEPENDENCIES, (
        f"limits no longer supports the {_ASYNC_REDIS_IMPLEMENTATION} client"
    )

    requirements = (
        Path(__file__).resolve().parents[1] / "requirements.txt"
    ).read_text()
    declared = {
        re.split(r"[<>=!\[ ]", line.strip(), 1)[0].lower()
        for line in requirements.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert package in declared, (
        f"the rate limiter's async Redis client ({package}) is not declared "
        "in backend/requirements.txt. It will work wherever Redis is absent "
        "and 500 every login wherever it is present."
    )
