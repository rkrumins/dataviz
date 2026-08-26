"""Rehearsing a real sign-in without performing one.

``/test`` dry-runs the claim mapping against a pasted blob. This covers the
other half — the half that actually breaks in production — by having an
admin complete a genuine IdP round-trip and reporting what *would* have
happened. The whole feature is worthless if it writes anything, so most of
this file is about that.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from sqlalchemy import func, select

from backend.app.db import models as _models
from backend.app.db.repositories import (
    idp_provider_repo,
    user_identity_repo,
    user_repo,
)
from backend.auth_service.core.tokens import (
    create_dryrun_token,
    create_link_intent_token,
    decode_dryrun_token,
)
from backend.auth_service.interface import SSOAuthError
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService
from backend.app.db.repositories.refresh_token_repo import make_refresh_store

import jwt as pyjwt


def _identity(email="rehearsal@corp.example", external_id="ext-dry",
              avatar_url=None):
    return ProviderIdentity(
        provider="oidc",
        external_id=external_id,
        email=email,
        first_name="Dry",
        last_name="Run",
        raw_claims={"kind": "oidc", "claims": {"sub": external_id},
                    "email_verified": True},
        groups=["engineering"],
        auth_time=None,
        attributes={},
        avatar_url=avatar_url,
    )


async def _provider(db_session, *, slug="dry", linking_policy="strict"):
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
        linking_policy=linking_policy,
    )
    await db_session.commit()
    return row


def _svc(db_session, previewer=None, avatar_fetcher=None):
    @asynccontextmanager
    async def factory():
        yield db_session

    return LocalIdentityService(
        session_factory=factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        # A real store, not ``lambda s: None``. Every one of these
        # fixtures used to pass None, so no test of an SSO login ever
        # touched refresh persistence — and allow-by-record makes the
        # record the token's licence to exist, so that gap now shows up
        # as an AttributeError rather than as a session that quietly
        # cannot be renewed.
        refresh_store_factory=make_refresh_store,
        sso_role_preview=previewer,
        avatar_fetcher=avatar_fetcher,
    )


async def _counts(db_session) -> tuple[int, int]:
    users = await db_session.scalar(
        select(func.count()).select_from(_models.UserORM)
    )
    identities = await db_session.scalar(
        select(func.count()).select_from(_models.UserIdentityORM)
    )
    return users, identities


# ── The point of the whole feature ───────────────────────────────────


@pytest.mark.asyncio
async def test_a_dry_run_writes_nothing(db_session):
    """The claim that makes this safe to hand to an operator."""
    provider = await _provider(db_session)
    before = await _counts(db_session)

    outcome = await _svc(db_session).preview_sso_login(
        _identity(), provider_id=provider.id, linking_policy="strict",
    )

    assert outcome["action"] == "provision_new"
    assert await _counts(db_session) == before


@pytest.mark.asyncio
async def test_it_reports_the_branch_that_would_fire(db_session):
    """An unknown subject whose email is free is a provision; the same
    subject once it exists is a plain sign-in."""
    provider = await _provider(db_session)
    svc = _svc(db_session)

    assert (await svc.preview_sso_login(
        _identity(), provider_id=provider.id,
    ))["action"] == "provision_new"

    user = await user_repo.create_sso_user(
        db_session, email="rehearsal@corp.example",
        first_name="Dry", last_name="Run", password_hash="x",
    )
    await user_identity_repo.create_identity(
        db_session, user_id=user.id, provider_id=provider.id,
        external_id="ext-dry", email_at_link=user.email,
    )
    await db_session.commit()

    outcome = await svc.preview_sso_login(
        _identity(), provider_id=provider.id,
    )
    assert outcome["action"] == "sign_in_existing"
    assert outcome["user_id"] == user.id


@pytest.mark.asyncio
async def test_it_names_the_reason_a_link_would_be_refused(db_session):
    """The failure an operator most needs explained: the account exists,
    the sign-in looks fine, and the platform still says no."""
    provider = await _provider(db_session, linking_policy="manual_only")
    existing = await user_repo.create_sso_user(
        db_session, email="rehearsal@corp.example",
        first_name="A", last_name="B", password_hash="x",
    )
    await db_session.commit()

    outcome = await _svc(db_session).preview_sso_login(
        _identity(), provider_id=provider.id, linking_policy="manual_only",
    )
    assert outcome["action"] == "rejected"
    assert outcome["reason"] == "unsafe_auto_link"
    assert "policy:manual_only" in outcome["deny_reasons"]
    assert outcome["user_id"] == existing.id


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [
    "strict", "allow_verified", "manual_only", "disabled",
])
async def test_the_rehearsal_and_the_real_login_agree(db_session, policy):
    """The property the whole feature rests on: whatever the dry-run says
    would happen is what happens.

    This used to be a test that grepped ``complete_sso_login`` for a
    function name — which is what you write when the structure cannot make
    the guarantee itself. Both paths now run the same
    ``_classify_sso_login``, so the agreement is checkable directly, for
    every linking policy including the ones that refuse.
    """
    provider = await _provider(db_session, slug=f"agree-{policy.replace(chr(95), chr(45))}",
                               linking_policy=policy)
    # A collision the policy actually decides: an ACTIVE local account, a
    # verified email, no identities yet. Get any of those wrong and every
    # policy refuses for the same non-policy reason, and the test passes
    # without ever exercising what it claims to.
    await user_repo.create_user(
        db_session, email="rehearsal@corp.example",
        password_hash="argon2-placeholder", first_name="A", last_name="B",
        status="active",
    )
    await db_session.commit()
    svc = _svc(db_session)

    predicted = await svc.preview_sso_login(
        _identity(), provider_id=provider.id, linking_policy=policy,
    )

    try:
        user, _tokens = await svc.complete_sso_login(
            _identity(), provider_id=provider.id,
            provider_slug=provider.slug, linking_policy=policy,
        )
    except SSOAuthError as exc:
        assert predicted["action"] == "rejected", (
            f"{policy}: rehearsal said {predicted['action']}, login refused"
        )
        assert predicted["reason"] == str(exc), (
            f"{policy}: rehearsal blamed {predicted['reason']}, "
            f"login blamed {exc}"
        )
    else:
        assert predicted["action"] != "rejected", (
            f"{policy}: rehearsal said refused, login succeeded"
        )
        assert predicted["user_id"] == user.id or \
            predicted["action"] == "provision_new"


@pytest.mark.asyncio
async def test_it_previews_the_group_mappings_that_would_match(db_session):
    provider = await _provider(db_session)

    async def previewer(session, *, idp_groups, provider_id):
        return {"matched": [{"idp_group": g} for g in idp_groups],
                "unmatched_groups": []}

    outcome = await _svc(db_session, previewer=previewer).preview_sso_login(
        _identity(), provider_id=provider.id,
    )
    assert outcome["reconcile"]["matched"] == [{"idp_group": "engineering"}]


@pytest.mark.asyncio
async def test_a_broken_previewer_does_not_sink_the_dry_run(db_session):
    """The mapping preview is the least important part of the answer."""
    provider = await _provider(db_session)

    async def previewer(session, **_kw):
        raise RuntimeError("mapping table is on fire")

    outcome = await _svc(db_session, previewer=previewer).preview_sso_login(
        _identity(), provider_id=provider.id,
    )
    assert outcome["action"] == "provision_new"
    assert "reconcile" not in outcome


# ── The marker cookie ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_requires_an_admin_and_mints_the_cookie(
    test_client, db_session,
):
    provider = await _provider(db_session, slug="dry-start")
    resp = await test_client.post(
        f"/api/v1/admin/idp-providers/{provider.id}/dry-run/start",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["loginUrl"] == "/api/v1/auth/dry-start/login"

    raw = resp.cookies.get("nx_dryrun")
    assert raw
    payload = decode_dryrun_token(raw)
    assert payload["provider_id"] == provider.id


@pytest.mark.asyncio
async def test_start_404s_for_an_unknown_provider(test_client):
    resp = await test_client.post(
        "/api/v1/admin/idp-providers/idp_nope/dry-run/start",
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_the_cookie_must_be_for_this_provider(db_session):
    """Otherwise a rehearsal started against a staging IdP would silence a
    real login through a different one."""
    from starlette.requests import Request

    from backend.auth_service.api.router import _is_dryrun

    token = create_dryrun_token(admin_id="u1", provider_id="idp_a")
    request = Request({
        "type": "http", "headers": [(b"cookie", f"nx_dryrun={token}".encode())],
    })
    assert _is_dryrun(request, provider_id="idp_a") is True
    assert _is_dryrun(request, provider_id="idp_b") is False


# ── The whole round trip ─────────────────────────────────────────────




@pytest.fixture()
async def sso_client(test_client, db_session):
    """``test_client`` wires an identity service for local login only — no
    ``user_identity_repo``, so any SSO completion rejects with
    ``identity_repo_unavailable``. These tests need the SSO half."""
    from backend.app.main import app

    previous = app.state.identity_service
    app.state.identity_service = _svc(db_session)
    yield test_client
    app.state.identity_service = previous


async def _callback(test_client, monkeypatch, db_session, *, dry_run: bool):
    """Drive ``GET /auth/{slug}/callback`` to the point where the identity
    is in hand, with the IdP token exchange stubbed out."""
    from backend.auth_service.core.tokens import create_oidc_state_token
    from backend.auth_service.providers.oidc import OidcProvider

    provider = await _provider(db_session, slug="dry-e2e")

    captured: dict = {}

    async def _fetch(self, *, code, code_verifier, nonce):
        captured["code_verifier"] = code_verifier
        return _identity()

    monkeypatch.setattr(OidcProvider, "fetch_identity", _fetch)

    state_token = create_oidc_state_token(
        state="st", nonce="no", code_verifier="the-verifier", next_path="/",
    )
    cookies = f"nx_oidc={state_token}"
    if dry_run:
        cookies += ";nx_dryrun=" + create_dryrun_token(
            admin_id="u1", provider_id=provider.id,
        )
    resp = await test_client.get(
        "/api/v1/auth/dry-e2e/callback?code=abc&state=st",
        headers={"Cookie": cookies},
        follow_redirects=False,
    )
    return resp, captured


@pytest.mark.asyncio
async def test_the_pkce_verifier_survives_the_state_cookie(
    sso_client, monkeypatch, db_session, registry,
):
    """Regression: the callback read the verifier under its pre-token field
    name, so it raised KeyError — caught by the broad handler below it and
    reported as ``token_or_idtoken``. Every OIDC sign-in failed there, and
    failed looking like the IdP's fault."""
    _resp, captured = await _callback(
        sso_client, monkeypatch, db_session, dry_run=False,
    )
    assert captured["code_verifier"] == "the-verifier"


@pytest.mark.asyncio
async def test_the_callback_mints_no_session_for_a_dry_run(
    sso_client, monkeypatch, db_session, registry,
):
    before = await _counts(db_session)
    resp, _ = await _callback(
        sso_client, monkeypatch, db_session, dry_run=True,
    )

    assert resp.status_code == 200
    assert "Would create a new account" in resp.text
    assert "nx_access" not in resp.headers.get("set-cookie", "")
    assert await _counts(db_session) == before


@pytest.mark.asyncio
async def test_without_the_cookie_the_same_callback_really_logs_in(
    sso_client, monkeypatch, db_session, registry,
):
    """The control: proves the dry-run branch is what stopped the writes,
    not a broken stub."""
    before = await _counts(db_session)
    resp, _ = await _callback(
        sso_client, monkeypatch, db_session, dry_run=False,
    )

    assert resp.status_code == 302
    assert "nx_access" in resp.headers.get("set-cookie", "")
    assert await _counts(db_session) != before


@pytest.mark.asyncio
async def test_another_token_kind_is_not_a_dry_run_marker(db_session):
    """The cookie is signed with the same key as every other flow token, so
    the audience/purpose check is the only thing separating them."""
    from starlette.requests import Request

    from backend.auth_service.api.router import _is_dryrun

    token = create_link_intent_token(user_id="u1", provider_id="idp_a")
    request = Request({
        "type": "http", "headers": [(b"cookie", f"nx_dryrun={token}".encode())],
    })
    assert _is_dryrun(request, provider_id="idp_a") is False
    with pytest.raises(pyjwt.InvalidTokenError):
        decode_dryrun_token(token)


# ── the avatar leg of the verdict ────────────────────────────────────
#
# The rehearsal performs the same guarded avatar GET a real sign-in
# would (storing nothing) and reports what happened — the only surface
# an operator has for a fetch that otherwise fails as one log line.


@pytest.mark.asyncio
async def test_no_avatar_url_is_said_in_the_verdict(db_session):
    provider = await _provider(db_session, slug="dry-av0")
    outcome = await _svc(db_session).preview_sso_login(
        _identity(), provider_id=provider.id,
    )
    assert outcome["avatar"] == {"url": None}


@pytest.mark.asyncio
async def test_a_fetchable_avatar_reports_type_and_size(db_session):
    async def fetcher(url):
        return b"png-bytes", "image/png"

    provider = await _provider(db_session, slug="dry-av1")
    outcome = await _svc(db_session, avatar_fetcher=fetcher).preview_sso_login(
        _identity(avatar_url="https://avatars.example.com/dry.png"),
        provider_id=provider.id,
    )
    assert outcome["avatar"] == {
        "url": "https://avatars.example.com/dry.png",
        "fetched": True, "content_type": "image/png", "size": 9,
    }


@pytest.mark.asyncio
async def test_a_refused_avatar_carries_the_guard_reason(db_session):
    from backend.auth_service.providers.outbound import (
        BlockedOutboundRequest,
    )

    async def fetcher(url):
        raise BlockedOutboundRequest(
            f"{url!r} is not on the avatar image hosts list.",
            reason="host_not_allowlisted",
        )

    provider = await _provider(db_session, slug="dry-av2")
    outcome = await _svc(db_session, avatar_fetcher=fetcher).preview_sso_login(
        _identity(avatar_url="https://elsewhere.example/x.png"),
        provider_id=provider.id,
    )
    assert outcome["avatar"]["fetched"] is False
    assert outcome["avatar"]["reason"] == "host_not_allowlisted"
    assert "avatar image hosts list" in outcome["avatar"]["detail"]


@pytest.mark.asyncio
async def test_a_deployment_with_no_fetcher_says_so(db_session):
    provider = await _provider(db_session, slug="dry-av3")
    outcome = await _svc(db_session).preview_sso_login(
        _identity(avatar_url="https://avatars.example.com/dry.png"),
        provider_id=provider.id,
    )
    assert outcome["avatar"] == {
        "url": "https://avatars.example.com/dry.png",
        "fetched": False, "reason": "fetch_unavailable",
    }
