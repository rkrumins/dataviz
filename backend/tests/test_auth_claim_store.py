"""Workspace grants served from the session store, and the fallbacks.

The access token does not carry per-workspace grants — it cannot, they
outgrow a cookie — so the session store answers for them. That introduces
three ways to be wrong, and every one of them shows up as a user silently
losing access rather than as an error:

* the store cannot answer, and the request is treated as "no grants"
  instead of escalating to the database;
* nothing can answer, and "unknown" is reported as "none", which becomes a
  403 asserting something the server never established;
* a token that carries its own grants is answered from the store anyway,
  which is the shape a tab left open across the deploy is holding.

These drive the real dependency rather than the dataclass, because the
precedence rule lives in the dependency.
"""
from __future__ import annotations

import json

import pytest
from starlette.requests import Request

from backend.app.auth import dependencies as deps
from backend.app.services import revocation_service as revocation_mod
from backend.app.services.permission_service import PermissionClaims, WS_CLAIM
from backend.app.services.revocation_service import (
    InMemoryBackend,
    RevocationBackendError,
    RevocationService,
)
from backend.auth_service.cookies import ACCESS_COOKIE_NAME
from backend.auth_service.core.tokens import create_access_token


_WS = ("workspace:read", "workspace:write")
_USER = "usr_claimstore"
_SID = "sess_claimstore"


def _request(token: str) -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/v1/anything",
        "headers": [(b"cookie", f"{ACCESS_COOKIE_NAME}={token}".encode())],
        "query_string": b"",
        "client": ("10.0.0.1", 1234),
    })


def _token(*, include_ws: bool, ws: dict | None = None) -> str:
    claims = PermissionClaims(
        sid=_SID,
        global_perms=("user:read",),
        ws_perms=ws if ws is not None else {"ws_a": _WS},
    )
    extra = claims.to_jwt_dict()
    if include_ws:
        # Pre-split shape, built explicitly: the encoder cannot emit it.
        extra[WS_CLAIM] = {
            ws: list(perms) for ws, perms in claims.ws_perms.items()
        }
    return create_access_token(_USER, "a@b.c", "user", extra=extra)


@pytest.fixture()
def store(monkeypatch) -> RevocationService:
    """A real RevocationService over the in-memory backend."""
    svc = RevocationService(InMemoryBackend())
    monkeypatch.setattr(revocation_mod, "_service", svc, raising=False)
    monkeypatch.setattr(deps, "get_revocation_service", lambda: svc)
    return svc


# ── The store path ───────────────────────────────────────────────────

async def test_a_slim_token_gets_its_grants_from_the_store(store):
    await store.record_session(
        _USER, _SID,
        claims=PermissionClaims(
            sid=_SID, ws_perms={"ws_a": _WS, "ws_b": ("workspace:read",)},
        ).to_session_dict(),
    )

    claims = await deps.get_permission_claims(_request(_token(include_ws=False)))

    assert claims.sid == _SID
    assert claims.global_perms == ("user:read",)
    assert claims.ws_perms == {"ws_a": _WS, "ws_b": ("workspace:read",)}


async def test_an_embedded_token_never_consults_the_store(store, monkeypatch):
    """The open-tab case, and the precedence rule.

    A token minted before the split carries its own grants and has **no**
    store entry. If the read path consulted the store regardless, every
    tab that was open when this deployed would lose its workspace
    permissions — the exact failure the compatibility branch exists for.
    Nothing is recorded here on purpose.
    """
    called = False

    async def _tripwire(sid):  # pragma: no cover - must not run
        nonlocal called
        called = True
        raise AssertionError("the store was consulted for an embedded token")

    monkeypatch.setattr(store, "read_session", _tripwire)

    claims = await deps.get_permission_claims(
        _request(_token(include_ws=True, ws={"ws_open_tab": _WS})),
    )

    assert claims.ws_perms == {"ws_open_tab": _WS}
    assert called is False


async def test_an_embedded_empty_map_is_honoured_not_looked_up(store):
    """A user with no workspaces is not a user with unknown workspaces.

    Presence of the claim decides, not truthiness. Were it truthiness, an
    empty-but-present map would fall through to the store, and a token
    that legitimately grants nothing would pick up grants from elsewhere.
    """
    await store.record_session(
        _USER, _SID,
        claims={WS_CLAIM: {"ws_should_not_be_used": list(_WS)}},
    )

    claims = await deps.get_permission_claims(
        _request(_token(include_ws=True, ws={})),
    )

    assert claims.ws_perms == {}


# ── Fallbacks: never a silent downgrade ──────────────────────────────

async def test_an_unreachable_store_escalates_to_the_database(store, monkeypatch):
    """A store outage must not read as "this user has no access".

    Treating it that way produces a 200 that authorises nothing — a denial
    dressed as success, which is the same silent shape as the dropped
    cookie. It has to escalate.
    """
    async def _boom(sid):
        raise RevocationBackendError("redis is gone")

    monkeypatch.setattr(store, "read_session", _boom)
    seen: list[str] = []

    async def _from_db(user_id):
        seen.append(user_id)
        return {"ws_from_db": _WS}

    monkeypatch.setattr(deps, "_workspace_grants_from_db", _from_db)

    claims = await deps.get_permission_claims(_request(_token(include_ws=False)))

    assert claims.ws_perms == {"ws_from_db": _WS}
    assert seen == [_USER], "the database fallback keys on the token's sub"


async def test_a_missing_entry_escalates_too(store, monkeypatch):
    """An expired entry is indistinguishable from an outage, and resolves
    the same way. The store answering "nothing" is not the store saying
    "this user has nothing"."""
    called: list[str] = []

    async def _from_db(user_id):
        called.append(user_id)
        return {"ws_recovered": _WS}

    monkeypatch.setattr(deps, "_workspace_grants_from_db", _from_db)

    # Nothing recorded: read_session succeeds and returns claims=None.
    claims = await deps.get_permission_claims(_request(_token(include_ws=False)))

    assert claims.ws_perms == {"ws_recovered": _WS}
    assert called == [_USER]


async def test_nothing_can_answer_is_flagged_rather_than_reported_as_empty(
    store, monkeypatch,
):
    """The end of the chain. ``{}`` and "unknown" are different values.

    Once Redis and Postgres have both declined, there is no way to find out
    what this user may do. Returning an empty grant map would hand
    ``requires`` something indistinguishable from a real answer, and it
    would answer 403 ``Missing permission: …`` — the "you don't have
    permissions" flash, rebuilt on purpose at the one moment the server is
    least entitled to make a claim. So the empty map is *flagged*, and
    consumers that needed it answer 503.
    """
    async def _boom(sid):
        raise RevocationBackendError("redis is gone")

    async def _no_database(user_id):
        return None

    monkeypatch.setattr(store, "read_session", _boom)
    monkeypatch.setattr(deps, "_workspace_grants_from_db", _no_database)

    claims = await deps.get_permission_claims(_request(_token(include_ws=False)))

    assert claims.ws_perms == {}
    assert claims.ws_available is False
    # The token's own half is untouched — it never needed a lookup.
    assert claims.global_perms == ("user:read",)


async def test_a_genuinely_empty_grant_map_is_an_answer(store):
    """The other side of the same coin, and the reason the flag exists.

    A user bound into no workspaces is a perfectly ordinary user. If
    emptiness alone implied "unknown", every one of them would get 503s
    from workspace-scoped routes instead of the 403 they have earned.
    """
    await store.record_session(
        _USER, _SID, claims=PermissionClaims(sid=_SID).to_session_dict(),
    )

    claims = await deps.get_permission_claims(_request(_token(include_ws=False)))

    assert claims.ws_perms == {}
    assert claims.ws_available is True


async def test_the_database_fallback_reports_a_failure_as_unknown(monkeypatch):
    """Guards the bottom of the chain directly.

    ``_workspace_grants_from_db`` swallowing its exception and returning
    ``{}`` is a one-word change that no request-level test would notice on
    a machine that happens to have a reachable Postgres.
    """
    async def _boom(session, user_id, **kwargs):
        raise RuntimeError("postgres is down")

    monkeypatch.setattr(
        "backend.app.services.permission_service.resolve", _boom,
    )
    deps.reset_db_fallback_cache()

    assert await deps._workspace_grants_from_db(_USER) is None


async def test_me_permissions_refuses_to_publish_an_unknown_grant_map():
    """``GET /me/permissions`` must fail rather than under-report.

    The SPA store installs whatever this returns. A 200 with an empty
    ``ws`` would overwrite a known-good claim set and blank every
    workspace-gated control in the UI; an error leaves the previous claims
    in place, which is the correct behaviour for "cannot tell right now".
    """
    from fastapi import HTTPException

    from backend.app.api.v1.endpoints.me import get_my_permissions

    with pytest.raises(HTTPException) as caught:
        await get_my_permissions(
            _user=None,  # unused by the handler; the dependency did the work
            claims=PermissionClaims(
                sid=_SID, global_perms=("user:read",), ws_available=False,
            ),
        )
    assert caught.value.status_code == 503


async def test_a_corrupt_payload_escalates_rather_than_authorising_nothing(
    store, monkeypatch,
):
    await store._backend.set_value(
        revocation_mod._session_claims_key(_SID), "{not json", 60,
    )

    async def _from_db(user_id):
        return {"ws_recovered": _WS}

    monkeypatch.setattr(deps, "_workspace_grants_from_db", _from_db)

    claims = await deps.get_permission_claims(_request(_token(include_ws=False)))
    assert claims.ws_perms == {"ws_recovered": _WS}


# ── The store read must not weaken revocation ────────────────────────

async def test_reading_claims_and_revocation_is_one_round_trip(store):
    """Both facts come back together.

    The tombstone check already ran on every authenticated request, so
    folding the claim fetch into the same call is what makes the stored
    claims free rather than doubling per-request Redis traffic.
    """
    calls = 0
    original = store._backend.exists_and_get

    async def _counting(flag_key, value_key):
        nonlocal calls
        calls += 1
        return await original(flag_key, value_key)

    store._backend.exists_and_get = _counting  # type: ignore[method-assign]
    await store.record_session(
        _USER, _SID, claims=PermissionClaims(sid=_SID).to_session_dict(),
    )

    state = await store.read_session(_SID)

    assert calls == 1
    assert state.revoked is False
    # The stored half carries the dedup layout too: an empty grant map and
    # an empty permission-set table.
    assert state.claims is not None
    assert state.claims[WS_CLAIM] == {}


async def test_revocation_still_reads_through_the_same_entry(store):
    """Storing claims must not disturb the tombstone semantics.

    They are separate keys precisely so that *existence* keeps meaning
    "revoked" — if the payload shared that key, a session with claims
    would be indistinguishable from a revoked one.
    """
    await store.record_session(
        _USER, _SID, claims=PermissionClaims(sid=_SID, ws_perms={"w": _WS}).to_session_dict(),
    )
    assert (await store.read_session(_SID)).revoked is False

    await store.revoke_session(_SID)

    state = await store.read_session(_SID)
    assert state.revoked is True
    # Still readable: revocation is enforced by the caller, and the claims
    # remaining legible is what lets a revoked request be diagnosed.
    assert state.claims is not None


async def test_the_claim_entry_outlives_the_revocation_window():
    """One session rotates through many access tokens.

    Sized to the revocation TTL, the entry would expire while the session
    was still valid, and the user's workspace grants would vanish partway
    through their own session for no visible reason.
    """
    from backend.app.services.revocation_service import (
        REVOCATION_TTL_SECONDS,
        SESSION_CLAIMS_TTL_SECONDS,
    )
    from backend.auth_service.core.config import JWT_REFRESH_EXPIRY_DAYS

    assert SESSION_CLAIMS_TTL_SECONDS > REVOCATION_TTL_SECONDS
    assert SESSION_CLAIMS_TTL_SECONDS >= JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60
