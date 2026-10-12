"""Every refused sign-in names who, why and where — and the digest that
turns those records into one row per person.

An admin looking at "Failed login for x (invalid_credentials)" could not
tell a mistyped password from an account that has no password to type,
could not see refusals from the fetch-based sign-in routes at all, and had
no way to know whether the person had since got in. These pin the record
each path writes and what the diagnostics page reads back from them.
"""
from __future__ import annotations

import json

import pytest

from backend.app.api.v1.endpoints import sso_failures
from backend.app.api.v1.endpoints.audit import (
    _EVENT_META,
    _SSO_PREFIXES,
    _summary_login_failed,
    _summary_sso_failure,
)
from backend.app.api.v1.endpoints.sso_failures import Row, digest, split_reason
from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories import (
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.auth_service.core.password import (
    disabled_password_hash,
    hash_password,
)

_PASSWORD = "Correct-Horse-9"


async def _user(db_session, email, *, status="active", password=_PASSWORD):
    user = await user_repo.create_user(
        db_session, email=email,
        password_hash=(hash_password(password) if password
                       else disabled_password_hash()),
        first_name="Pat", last_name="Doe", status=status,
    )
    await db_session.commit()
    return user


def _refusals(events):
    return [p for t, p in events if t == "user.login_failed"]


# ── password sign-in: which refusal it was ────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("setup, typed, reason", [
    ("none", "nobody@example.com", "user_not_found"),
    ("sso_only", "sso@example.com", "no_local_password"),
    ("suspended", "gone@example.com", "account_inactive"),
    ("password", "pw@example.com", "invalid_credentials"),
])
async def test_a_refused_password_sign_in_records_which_refusal_it_was(
    test_client, db_session, sso_events, setup, typed, reason,
):
    user = None
    if setup == "sso_only":
        user = await _user(db_session, typed, password=None)
    elif setup == "suspended":
        user = await _user(db_session, typed, status="suspended")
    elif setup == "password":
        user = await _user(db_session, typed)

    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": typed.upper(), "password": "Wrong-Password-1"},
        headers={"user-agent": "DiagBrowser/1.0"},
    )

    # The caller's answer does not change: which refusal it was is the
    # admin's to know.
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid email or password"
    [record] = _refusals(sso_events)
    assert record["reason"] == reason
    assert record["email"] == typed
    assert record.get("user_id") == (user.id if user else None)
    assert record["user_agent"] == "DiagBrowser/1.0"
    assert record["client_ip"]
    assert record["path"] == "/api/v1/auth/login"
    if reason == "account_inactive":
        assert record["status"] == "suspended"


@pytest.mark.asyncio
async def test_a_throttled_password_sign_in_is_recorded(
    test_client, db_session, sso_events, monkeypatch,
):
    from backend.auth_service.api import router as auth_router

    class _Closed:
        async def check(self, *a):
            return False

        async def retry_after_seconds(self, *a):
            return 30

    monkeypatch.setattr(auth_router, "get_account_limiter", lambda: _Closed())
    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "Busy@Example.com", "password": "x"},
    )
    assert resp.status_code == 429
    [record] = _refusals(sso_events)
    assert record["reason"] == "throttled"
    assert record["email"] == "busy@example.com"


# ── fetch-based SSO sign-in: refusals are recorded ────────────────────


async def _fetch_provider(db_session, **over):
    settings = {
        "token_source": "cookie", "token_source_key": "corp_session",
        "gateway_url": "https://gw.corp.example/redeem",
        "gateway_send_as": "cookie",
        "gateway_token_path": "access_token",
        "exchange_url": "https://gw.corp.example/userinfo",
    }
    settings.update(over)
    row = await idp_provider_repo.create_provider(
        db_session, slug="corp-gw", display_name="Corporate",
        kind="backchannel", settings=settings, claim_mapping={},
        linking_policy="manual_only",
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()
    return row


@pytest.mark.asyncio
async def test_a_refused_fetch_sign_in_is_recorded_under_the_ref_it_returns(
    test_client, db_session, registry, sso_events,
):
    row = await _fetch_provider(db_session)

    resp = await test_client.post(
        "/api/v1/auth/corp-gw/backchannel", json={},
        headers={"user-agent": "DiagBrowser/2.0"},
    )

    assert resp.status_code == 401
    body = resp.json()["detail"]
    assert body["error"] == "backchannel_no_session"
    [record] = [p for t, p in sso_events if t == "user.sso_login_failed"]
    assert record["ref"] == body["ref"]
    assert record["reason"] == "backchannel_no_session"
    assert record["provider_slug"] == "corp-gw"
    assert record["provider_id"] == row.id
    assert record["detail"]  # the provider's own account of what was missing
    assert record["user_agent"] == "DiagBrowser/2.0"
    assert record["path"] == "/api/v1/auth/corp-gw/backchannel"


@pytest.mark.asyncio
async def test_a_refused_link_is_recorded_against_the_account_it_concerns(
    test_client, db_session, registry, sso_events, monkeypatch,
):
    import httpx
    from backend.auth_service.providers import outbound

    real = httpx.AsyncClient

    def _dispatch(request):
        if request.url.path.endswith("/redeem"):
            return httpx.Response(200, json={"access_token": "gw"})
        return httpx.Response(200, json={
            "sub": "emp-7", "email": "Alice@Corp.example",
            "firstName": "Alice", "lastName": "A",
        })

    monkeypatch.setattr(
        outbound.httpx, "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(_dispatch), **kw),
    )
    await _fetch_provider(db_session)
    alice = await _user(db_session, "alice@corp.example")

    resp = await test_client.post(
        "/api/v1/auth/corp-gw/backchannel", json={},
        cookies={"corp_session": "ambient"},
    )

    assert resp.status_code == 401
    [record] = [p for t, p in sso_events if t == "user.sso_login_failed"]
    assert record["reason"] == "sso_login_rejected:unsafe_auto_link"
    assert record["email"] == "alice@corp.example"
    assert record["user_id"] == alice.id
    assert record["external_id"] == "emp-7"
    assert record["ref"] == resp.json()["detail"]["ref"]


# ── session renewals refused for a reason nothing else records ────────


@pytest.mark.asyncio
async def test_a_reused_refresh_token_records_why_the_session_ended(
    db_session, sso_events, monkeypatch,
):
    from backend.app.main import app
    from backend.auth_service.interface import InvalidRefreshToken

    svc = app.state.identity_service
    user = await _user(db_session, "twice@example.com")
    _, tokens = await svc.login("twice@example.com", _PASSWORD)
    await svc.refresh(tokens.refresh_token)
    monkeypatch.setattr(
        "backend.auth_service.service.REFRESH_ROTATION_GRACE_SECONDS", 0,
    )

    with pytest.raises(InvalidRefreshToken):
        await svc.refresh(tokens.refresh_token)

    ended = [p for t, p in sso_events if t == "user.session_refused"]
    assert ended == [{"user_id": user.id, "reason": "reuse_detected"}]


# ── what the audit lens says about them ───────────────────────────────


def test_summaries_end_with_the_reason_and_name_the_person():
    assert _summary_login_failed(
        {"email": "a@x.io", "reason": "no_local_password"},
    ) == "Failed password sign-in for a@x.io: no_local_password"
    # A row without a reason no longer claims to know which it was.
    assert _summary_login_failed({"email": "a@x.io"}).endswith(": unspecified")
    assert _summary_sso_failure({
        "ref": "ab12cd34", "provider_slug": "corp", "email": "a@x.io",
        "reason": "backchannel_no_session",
    }) == "[ab12cd34] Sign-in via corp failed for a@x.io: backchannel_no_session"
    assert _summary_sso_failure({
        "ref": "ab12cd34", "provider_slug": "corp", "reason": "state_mismatch",
    }) == "[ab12cd34] Sign-in via corp failed: state_mismatch"


def test_session_events_are_on_the_sso_lens_with_a_summary():
    for event_type in ("user.session_refused", "user.sso_session_ended_upstream"):
        assert any(event_type.startswith(p) for p in _SSO_PREFIXES)
        severity, build = _EVENT_META[event_type]
        assert severity == "info"
        assert build({"user_id": "usr_1", "reason": "idle"}).endswith(": idle")


# ── the digest ────────────────────────────────────────────────────────


@pytest.mark.parametrize("reason, expected", [
    ("backchannel_no_session", ("backchannel_no_session", None)),
    ("backchannel_idp_rejected:401", ("backchannel_idp_rejected:401", None)),
    ("bad_flow_cookie:Signature has expired",
     ("bad_flow_cookie", "Signature has expired")),
    ("idp_error=access_denied", ("idp_error", "access_denied")),
    ("sso_login_rejected:jit_disabled", ("jit_disabled", None)),
    ("", ("unknown", None)),
    (None, ("unknown", None)),
])
def test_split_reason(reason, expected):
    assert split_reason(reason) == expected


def _row(event_type, at, **payload):
    return Row(event_type, at, payload)


def _digest(rows, **over):
    kw = dict(email_to_user={}, accounts={}, ways_in={}, provider_names={})
    kw.update(over)
    return digest(rows, **kw)


def test_digest_groups_attempts_by_person_and_says_who_is_still_failing():
    rows = [
        _row("user.login_failed", "2026-09-29T10:05:00+00:00",
             email="ada@corp.io", reason="no_local_password", user_id="usr_a"),
        _row("user.sso_login_failed", "2026-09-29T10:00:00+00:00",
             provider_slug="corp", reason="backchannel_unavailable",
             detail="idp_status:503", user_id="usr_a", ref="r1",
             client_ip="10.0.0.5"),
        # Older rows carry only the email; resolved to the same account.
        _row("user.login_failed", "2026-09-29T09:00:00+00:00",
             email="ada@corp.io", reason="invalid_credentials"),
        _row("user.login_failed", "2026-09-29T09:30:00+00:00",
             email="bob@corp.io", reason="invalid_credentials",
             user_id="usr_b"),
        _row("user.sso_login_failed", "2026-09-29T08:00:00+00:00",
             provider_slug="corp", reason="backchannel_no_session"),
        _row("user.session_refused", "2026-09-29T08:30:00+00:00",
             user_id="usr_a", reason="reuse_detected"),
    ]
    out = _digest(
        rows,
        email_to_user={"ada@corp.io": "usr_a"},
        accounts={
            "usr_a": {"name": "Ada", "email": "ada@corp.io",
                      "status": "active", "password_set": False,
                      "last_login_at": "2026-09-28T00:00:00+00:00"},
            "usr_b": {"name": "Bob", "email": "bob@corp.io",
                      "status": "active", "password_set": True,
                      # Signed in after his failure: recovered.
                      "last_login_at": "2026-09-29T11:00:00+00:00"},
        },
        ways_in={"usr_a": [{"slug": "corp", "name": "Corporate",
                            "last_used_at": None}]},
        provider_names={"corp": "Corporate"},
    )

    ada, bob, nobody = out["people"]
    assert ada["user_id"] == "usr_a" and ada["attempts"] == 3
    assert ada["still_failing"] is True
    assert ada["password_set"] is False
    assert ada["latest"]["code"] == "no_local_password"
    assert ada["latest"]["provider"] == "password"
    assert {r["code"] for r in ada["reasons"]} == {
        "no_local_password", "backchannel_unavailable", "invalid_credentials",
    }
    assert ada["recent"][1]["detail"] == "idp_status:503"
    assert ada["clients"] == 1
    assert [e["reason"] for e in ada["session_ends"]] == ["reuse_detected"]
    assert ada["ways_in"][0]["slug"] == "corp"

    assert bob["still_failing"] is False
    assert nobody["kind"] == "unidentified"
    assert nobody["still_failing"] is None

    assert out["totals"] == {
        "attempts": 5, "people": 2, "still_failing": 1, "unidentified": 1,
    }
    assert out["reasons"][0] == {"code": "invalid_credentials", "count": 2}
    assert {"slug": "corp", "name": "Corporate", "count": 2} in out["providers"]


def test_filters_narrow_the_people_but_not_the_chips():
    rows = [
        _row("user.login_failed", "2026-09-29T10:00:00+00:00",
             email="a@x.io", reason="invalid_credentials"),
        _row("user.sso_login_failed", "2026-09-29T10:01:00+00:00",
             provider_slug="corp", reason="backchannel_no_session"),
    ]
    out = _digest(rows, reason="backchannel_no_session")
    assert [p["kind"] for p in out["people"]] == ["unidentified"]
    assert {r["code"] for r in out["reasons"]} == {
        "invalid_credentials", "backchannel_no_session",
    }
    out = _digest(rows, provider="password")
    assert [p["email"] for p in out["people"]] == ["a@x.io"]
    assert out["people"][0]["kind"] == "no_account"


def test_search_keeps_only_the_people_it_names():
    rows = [
        _row("user.login_failed", "2026-09-29T10:00:00+00:00",
             email="ada@x.io", reason="invalid_credentials"),
        _row("user.login_failed", "2026-09-29T10:00:00+00:00",
             email="bob@x.io", reason="invalid_credentials",
             detail="ada typed this"),
        _row("user.sso_login_failed", "2026-09-29T10:00:00+00:00",
             provider_slug="corp", reason="x", user_id="usr_c"),
    ]
    out = _digest(rows, search="ada", search_ids=frozenset({"usr_c"}))
    assert sorted(p["email"] or p["user_id"] for p in out["people"]) == [
        "ada@x.io", "usr_c",
    ]


# ── the endpoint ──────────────────────────────────────────────────────


async def _event(db_session, event_type, at, **payload):
    db_session.add(OutboxEventORM(
        event_type=event_type, created_at=at, payload=json.dumps(payload),
    ))


@pytest.mark.asyncio
async def test_the_endpoint_resolves_people_in_the_window(
    test_client, db_session,
):
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp", display_name="Corporate",
        kind="backchannel", settings={
            "token_source": "cookie", "token_source_key": "c",
            "gateway_url": "https://gw.example/redeem",
        }, claim_mapping={},
    )
    ada = await _user(db_session, "ada@corp.io", password=None)
    await user_identity_repo.create_identity(
        db_session, user_id=ada.id, provider_id=provider.id,
        external_id="emp-1", email_at_link="ada@corp.io",
    )
    await _event(db_session, "user.login_failed", "2099-01-01T10:00:00+00:00",
                 email="ada@corp.io", reason="invalid_credentials")
    await _event(db_session, "user.sso_login_failed",
                 "2099-01-01T09:59:00+00:00", provider_slug="corp",
                 reason="backchannel_no_session", ref="r1")
    # Outside the window.
    await _event(db_session, "user.login_failed", "2000-01-01T00:00:00+00:00",
                 email="old@corp.io", reason="invalid_credentials")
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/sso/failures",
        params={"fromTs": "2098-12-31T00:00:00+00:00"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["window"]["scanned"] == 2
    assert body["window"]["truncated"] is False
    person = next(p for p in body["people"] if p["kind"] == "account")
    assert person["userId"] == ada.id
    assert person["passwordSet"] is False
    [way_in] = person["waysIn"]
    assert (way_in["slug"], way_in["name"]) == ("corp", "Corporate")
    assert person["latest"]["code"] == "invalid_credentials"
    assert person["stillFailing"] is True
    assert body["providers"][0]["name"] in ("Corporate", None)
    assert body["totals"]["unidentified"] == 1


@pytest.mark.asyncio
async def test_a_search_finds_a_person_past_the_scan_cap(
    test_client, db_session, monkeypatch,
):
    """A flood of other failures must not hide the one person asked for:
    the search narrows the read itself, not the page after it."""
    monkeypatch.setattr(sso_failures, "SCAN_CAP", 3)
    for i in range(5):
        await _event(db_session, "user.login_failed",
                     f"2099-01-01T10:0{i}:00+00:00",
                     email=f"spray{i}@x.io", reason="user_not_found")
    await _event(db_session, "user.login_failed", "2099-01-01T09:00:00+00:00",
                 email="needle@x.io", reason="invalid_credentials")
    await db_session.commit()
    since = {"fromTs": "2098-12-31T00:00:00+00:00"}

    flood = (await test_client.get(
        "/api/v1/admin/sso/failures", params=since,
    )).json()
    assert flood["window"]["truncated"] is True
    assert flood["window"]["scanned"] == 3
    assert "needle@x.io" not in {p["email"] for p in flood["people"]}

    found = (await test_client.get(
        "/api/v1/admin/sso/failures", params={**since, "q": "needle"},
    )).json()
    assert [p["email"] for p in found["people"]] == ["needle@x.io"]


@pytest.mark.asyncio
async def test_the_endpoint_needs_audit_access(test_client, db_session):
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.main import app

    def _claims(perms):
        return lambda: PermissionClaims(
            sid="sess_test", global_perms=perms, ws_perms={},
        )

    try:
        app.dependency_overrides[get_permission_claims] = _claims(())
        refused = await test_client.get("/api/v1/admin/sso/failures")
        app.dependency_overrides[get_permission_claims] = _claims(
            ("system:audit:read",),
        )
        allowed = await test_client.get("/api/v1/admin/sso/failures")
    finally:
        app.dependency_overrides.pop(get_permission_claims, None)
    assert refused.status_code == 403
    assert allowed.status_code == 200


def test_an_unnamed_failure_from_the_same_browser_is_shown_beside_the_person():
    """A sign-in failed before it could say who; a minute later the same
    browser tried a password. The first is why the second happened."""
    browser = {"client_ip": "10.0.0.9", "user_agent": "Agent/1"}
    rows = [
        _row("user.login_failed", "2026-09-29T10:01:00+00:00",
             email="ada@corp.io", user_id="usr_a",
             reason="no_local_password", **browser),
        _row("user.sso_login_failed", "2026-09-29T10:00:00+00:00",
             provider_slug="corp", reason="backchannel_unavailable",
             detail="idp_status:503", ref="r9", **browser),
        # Same browser, but long before — not related.
        _row("user.sso_login_failed", "2026-09-29T08:00:00+00:00",
             provider_slug="corp", reason="backchannel_no_session", **browser),
        # Same time, another browser — not related.
        _row("user.sso_login_failed", "2026-09-29T10:00:30+00:00",
             provider_slug="corp", reason="backchannel_unavailable",
             client_ip="10.0.0.10", user_agent="Agent/1"),
    ]
    out = _digest(rows, accounts={"usr_a": {"status": "active"}},
                  provider="password")
    [ada] = out["people"]
    assert [r["ref"] for r in ada["related"]] == ["r9"]
    assert ada["related"][0]["detail"] == "idp_status:503"


@pytest.mark.asyncio
async def test_a_search_still_finds_the_unnamed_failure_from_their_browser(
    test_client, db_session,
):
    browser = {"client_ip": "10.9.9.9", "user_agent": "Agent/2"}
    await _event(db_session, "user.sso_login_failed",
                 "2099-01-01T10:00:00+00:00", provider_slug="corp",
                 reason="backchannel_unavailable", ref="rr11", **browser)
    await _event(db_session, "user.login_failed", "2099-01-01T10:01:00+00:00",
                 email="solo@x.io", reason="no_local_password", **browser)
    await db_session.commit()

    body = (await test_client.get(
        "/api/v1/admin/sso/failures",
        params={"fromTs": "2098-12-31T00:00:00+00:00", "q": "solo"},
    )).json()

    [person] = body["people"]
    assert [a["ref"] for a in person["related"]] == ["rr11"]
    # Context only: the unnamed failure is not counted in the search.
    assert body["totals"]["attempts"] == 1
    assert [r["code"] for r in body["reasons"]] == ["no_local_password"]
