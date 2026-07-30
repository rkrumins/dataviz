"""The access cookie must not grow without bound.

Permission claims used to ride in the access JWT in full, including the
per-workspace grants — roughly 200 bytes of cookie per workspace a user is
bound to. Past about 18 workspaces the cookie crossed the 4096-byte limit
browsers enforce, and the failure was **silent in every direction**:
``/auth/login`` answered 200, the ``Set-Cookie`` went out, the browser
discarded it, the next request arrived anonymous, and the SPA bounced the
user to /login with nothing logged anywhere. Because size depends on how
many workspaces that particular user holds, it presented as random
unreproducible sign-outs affecting the most privileged accounts first, and
it got worse as the product was adopted.

The grants now live in the session store, and the token embeds them only
while they fit inside a budget. These tests pin the ceiling, the budget
decision, and — most importantly — that a token minted *before* the split
keeps working, because that is what a tab left open across the deploy is
holding.
"""
from __future__ import annotations

import pytest

from backend.app.services.permission_service import PermissionClaims, WS_CLAIM
from backend.auth_service.cookies import (
    ACCESS_COOKIE_WARN_BYTES,
    MAX_COOKIE_BYTES,
    access_cookie_bytes,
)


# Real permission ids from this codebase's vocabulary — a synthetic short
# name would understate the size and the whole point here is the size.
_WS_PERMS = (
    "workspace:read", "workspace:write", "workspace:provider:read",
    "workspace:member:read", "workspace:view:read", "workspace:view:write",
)
_GLOBAL_PERMS = (
    "system:admin", "user:read", "user:write", "workspace:create",
    "provider:read", "provider:write", "audit:read", "feature:read",
)


def _claims(n_workspaces: int) -> PermissionClaims:
    return PermissionClaims(
        sid="sess_0123456789abcdefghij",
        global_perms=_GLOBAL_PERMS,
        # Ids shaped like the real ones; length matters to the total.
        ws_perms={f"ws_{i:012x}": _WS_PERMS for i in range(n_workspaces)},
    )


def _issue(user, claims: PermissionClaims):
    """Mint the way production does: the token half only.

    ``to_jwt_dict`` has no way to carry them, so the
    per-workspace grants never reach the token at all. There is no size
    decision anywhere in the mint — that conditional existed briefly and
    was removed, because "embed while it fits" made a user's authorization
    travel differently depending on how many workspaces they held, and left
    the store path exercised only by the largest tenants.
    """
    from backend.auth_service.core.tokens import create_access_token

    return create_access_token(
        user.id, user.email, user.role,
        extra=claims.to_jwt_dict(),
    )


class _User:
    id = "usr_0123456789ab"
    email = "someone@example.com"
    role = "super_admin"
    must_change_password = False


# ── The ceiling ──────────────────────────────────────────────────────

@pytest.mark.parametrize("n_workspaces", [0, 1, 5, 20, 60, 200])
def test_the_access_cookie_never_exceeds_what_browsers_accept(n_workspaces):
    """The headline property, at sizes that used to be fatal.

    200 workspace bindings produced a ~40 KB cookie before this — ten
    times the limit, discarded without a word.
    """
    token = _issue(_User(), _claims(n_workspaces))
    size = access_cookie_bytes(token)
    assert size <= MAX_COOKIE_BYTES, (
        f"{n_workspaces} workspaces produced a {size}B cookie; browsers "
        f"discard anything over {MAX_COOKIE_BYTES}B silently"
    )


def test_the_token_size_does_not_depend_on_workspace_count():
    """The invariant the whole change exists to establish.

    Not "small enough" — *constant*. Nothing a tenant can do by growing
    should move the access cookie at all, because the moment size depends
    on data, some customer eventually finds the edge and the failure is
    silent when they do.
    """
    sizes = {n: access_cookie_bytes(_issue(_User(), _claims(n)))
             for n in (0, 1, 20, 200, 2000)}
    assert len(set(sizes.values())) == 1, (
        f"token size varies with workspace count: {sizes}"
    )


def test_the_token_never_carries_workspace_grants():
    """One path for every session, large or small.

    This replaced an embed-while-it-fits budget. That version worked, but
    it meant a user with 99 bindings and a user with 101 exercised
    different authorization machinery, and the store path — the one
    serving the biggest tenants — was the one almost nothing tested.
    """
    import jwt as pyjwt

    from backend.app.services.permission_service import WS_SETS_CLAIM

    for n in (0, 2, 500):
        payload = pyjwt.decode(
            _issue(_User(), _claims(n)), options={"verify_signature": False},
        )
        assert WS_CLAIM not in payload
        assert WS_SETS_CLAIM not in payload
        # Identity and the bounded half still travel in the token.
        assert payload["sub"] == _User.id
        assert set(payload["global"]) == set(_GLOBAL_PERMS)
        assert payload["sid"] == "sess_0123456789abcdefghij"


def test_the_tripwire_threshold_leaves_real_headroom():
    """The margin absorbs what we cannot predict.

    An environment-suffixed cookie name, a longer signature if the
    algorithm changes, growth in the global permission vocabulary. The
    budget no longer gates a code path — it is where the tripwire starts
    warning — but a margin that had quietly shrunk to nothing would make
    that warning useless.
    """
    assert ACCESS_COOKIE_WARN_BYTES < MAX_COOKIE_BYTES
    assert MAX_COOKIE_BYTES - ACCESS_COOKIE_WARN_BYTES >= 512


# ── Compatibility: the no-hard-refresh requirement ───────────────────

def test_presence_not_emptiness_decides_where_grants_come_from():
    """The distinction the open-tab case rests on.

    A token minted before the split carries its own grants and has no
    store entry at all. A token minted after may legitimately carry an
    *empty* grant map — a user with no workspaces. Treating empty as
    "ask the store" would send the first case to a store that has nothing
    for it, and every already-open tab would lose its permissions the
    moment this deployed.
    """
    assert PermissionClaims.token_carries_ws({WS_CLAIM: {}}) is True
    assert PermissionClaims.token_carries_ws({WS_CLAIM: {"w": []}}) is True
    assert PermissionClaims.token_carries_ws({"sid": "s", "global": []}) is False


def test_an_old_format_token_round_trips_unchanged():
    """A pre-split token must decode to exactly the grants it carries.

    This is the shape sitting in a browser that was open when the deploy
    happened — grants embedded, nothing in the store.
    """
    claims = _claims(3)
    old_payload = {
        **claims.to_jwt_dict(),
        WS_CLAIM: {
            ws: list(perms) for ws, perms in claims.ws_perms.items()
        },
    }
    restored = PermissionClaims.from_jwt_dict(old_payload)
    assert len(restored.ws_perms) == 3
    assert restored.ws_perms["ws_000000000001"] == _WS_PERMS
    assert restored.global_perms == _GLOBAL_PERMS


def test_the_two_halves_compose_into_the_whole():
    """Token half plus store half must reconstitute the resolution.

    With one carrier for grants the risk is no longer the two disagreeing
    — it is a field going missing at the seam. Merging them has to give
    back exactly what was resolved.
    """
    claims = _claims(4)
    from_token = PermissionClaims.from_jwt_dict(claims.to_jwt_dict())
    from_store = PermissionClaims.from_jwt_dict(
        {**claims.to_jwt_dict(), **claims.to_session_dict()},
    )
    # The token half carries identity and global rights, and no grants.
    assert from_token.ws_perms == {}
    assert from_token.global_perms == _GLOBAL_PERMS
    assert from_token.sid == claims.sid
    # Merged, the two halves are the original resolution.
    assert from_store.ws_perms == claims.ws_perms
    assert from_store.global_perms == _GLOBAL_PERMS
    assert from_store.sid == claims.sid


# ── Dedupe by index ──────────────────────────────────────────────────

def test_identical_grant_sets_are_stored_once():
    """The redundancy that made the cookie 44 KB.

    Every workspace a user holds the same role on resolves to the same
    permission list, and the old layout wrote it out in full for each —
    150 workspaces produced 150 verbatim copies of one array, 29 KB of
    JSON that was ~99% repetition.
    """
    from backend.app.services.permission_service import WS_SETS_CLAIM

    payload = _claims(150).to_session_dict()
    assert len(payload[WS_SETS_CLAIM]) == 1
    assert len(payload[WS_CLAIM]) == 150
    assert set(payload[WS_CLAIM].values()) == {0}


def test_distinct_grant_sets_each_get_an_entry():
    """Dedup must not collapse genuinely different grants together."""
    from backend.app.services.permission_service import WS_SETS_CLAIM

    claims = PermissionClaims(
        sid="s",
        ws_perms={
            "ws_admin": _WS_PERMS,
            "ws_reader": ("workspace:read",),
            "ws_admin2": _WS_PERMS,
        },
    )
    payload = claims.to_session_dict()
    assert len(payload[WS_SETS_CLAIM]) == 2
    assert payload[WS_CLAIM]["ws_admin"] == payload[WS_CLAIM]["ws_admin2"]
    assert payload[WS_CLAIM]["ws_reader"] != payload[WS_CLAIM]["ws_admin"]
    # And it round-trips to exactly what went in.
    assert PermissionClaims.from_jwt_dict(payload).ws_perms == claims.ws_perms


@pytest.mark.parametrize("n_workspaces", [0, 1, 3, 150, 500])
def test_the_encoding_is_lossless(n_workspaces):
    original = _claims(n_workspaces)
    # The encoding under test is the store payload's — the token has no
    # grants left to encode.
    assert PermissionClaims.from_jwt_dict(
        original.to_session_dict()
    ).ws_perms == original.ws_perms


def test_an_inline_token_still_decodes():
    """The compatibility branch, and why it exists.

    A tab that was already open when the dedup deployed is holding a token
    with inline permission lists. The reader recognises the layout per
    value rather than assuming one, so that tab keeps its grants with no
    reload. Removable once one refresh TTL has passed and no inline token
    can exist.
    """
    inline = {
        "sid": "s",
        "global": ["user:read"],
        WS_CLAIM: {"ws_a": list(_WS_PERMS), "ws_b": ["workspace:read"]},
    }
    restored = PermissionClaims.from_jwt_dict(inline)
    assert restored.ws_perms == {
        "ws_a": _WS_PERMS, "ws_b": ("workspace:read",),
    }


def test_a_dangling_index_costs_only_that_workspace():
    """A malformed token should not 500 the request.

    Losing access to a workspace the token cannot describe is the right
    failure; taking the whole request down with a KeyError is not.
    """
    from backend.app.services.permission_service import WS_SETS_CLAIM

    restored = PermissionClaims.from_jwt_dict({
        "sid": "s",
        WS_CLAIM: {"ws_ok": 0, "ws_dangling": 7},
        WS_SETS_CLAIM: [list(_WS_PERMS)],
    })
    assert restored.ws_perms["ws_ok"] == _WS_PERMS
    assert restored.ws_perms["ws_dangling"] == ()


def test_the_dedup_keeps_the_store_payload_small():
    """What the dedup is for, now that it is not holding back a cliff.

    It no longer prevents an oversized cookie — the token carries no
    grants at all, so nothing can. What it still does is keep the stored
    payload and the Redis memory behind it roughly ninefold smaller, which
    is worth having on its own.
    """
    import json

    from backend.app.services.permission_service import WS_SETS_CLAIM

    stored = _claims(150).to_session_dict()
    deduped = len(json.dumps(stored, separators=(",", ":")))
    inline = len(json.dumps(
        {WS_CLAIM: {ws: list(p) for ws, p in _claims(150).ws_perms.items()}},
        separators=(",", ":"),
    ))
    assert len(stored[WS_SETS_CLAIM]) == 1
    assert deduped * 5 < inline, (
        f"dedup gave {inline}B -> {deduped}B; expected a much larger win"
    )


def test_the_store_half_always_carries_the_full_grant_set():
    """Written unconditionally, including when the token also has them.

    Making the store write conditional on the mint's size decision would
    mean coordinating two code paths that run at different times — and a
    session whose grants were never stored has nowhere to read them from
    if it later sheds them on rotation.
    """
    for n in (0, 2, 200):
        stored = _claims(n).to_session_dict()
        assert len(stored[WS_CLAIM]) == n
