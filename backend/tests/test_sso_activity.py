"""The SSO activity lens, and the failure reference that makes it usable.

An SSO failure is deliberately opaque to the user — naming the cause would
leak configuration to anyone who can reach /login. The reason was always
recorded; it just had no reader and nothing tied it to the person who hit
it. These tests pin both halves: the ``ref`` on the redirect, and the
narrowed audit view an admin searches it in.
"""
from __future__ import annotations

import re

import pytest

from backend.app.api.v1.endpoints.audit import (
    _EVENT_META,
    _HIDE_BY_CATEGORY,
    _SSO_PREFIXES,
)
from backend.app.db.repositories import idp_provider_repo


# ── The reference on a failed sign-in ────────────────────────────────


@pytest.mark.asyncio
async def test_a_failed_sign_in_carries_a_reference(
    test_client, db_session, registry, sso_events,
):
    await idp_provider_repo.create_provider(
        db_session, slug="ref-portal", display_name="Portal",
        kind="custom_profile",
        settings={"source": "cookie", "source_key": "corp_profile",
                  "payload_format": "jwt", "shared_secret": "s" * 48},
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/auth/ref-portal/login", follow_redirects=False,
    )
    assert resp.status_code == 302
    match = re.search(r"ref=([0-9a-f]{8})", resp.headers["location"])
    assert match, resp.headers["location"]

    # The same ref reaches the audit log, carrying the reason the user was
    # NOT told. That pairing is the whole point.
    failures = [p for t, p in sso_events if t == "user.sso_login_failed"]
    assert len(failures) == 1
    assert failures[0]["ref"] == match.group(1)
    assert failures[0]["provider_slug"] == "ref-portal"
    assert "payload_missing" in failures[0]["reason"]


@pytest.mark.asyncio
async def test_the_reason_never_reaches_the_user(
    test_client, db_session, registry, sso_events,
):
    """The redirect must carry the ref and nothing diagnostic."""
    await idp_provider_repo.create_provider(
        db_session, slug="quiet-portal", display_name="Portal",
        kind="custom_profile",
        settings={"source": "cookie", "source_key": "corp_profile",
                  "payload_format": "jwt", "shared_secret": "s" * 48},
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/auth/quiet-portal/login", follow_redirects=False,
    )
    location = resp.headers["location"]
    assert "sso_error=1" in location
    for leaked in ("payload", "missing", "reason", "cookie"):
        assert leaked not in location.lower(), location


@pytest.mark.asyncio
async def test_each_failure_gets_a_distinct_reference(
    test_client, db_session, registry, sso_events,
):
    """Two users hitting the same fault must be distinguishable, or the ref
    is useless for support."""
    await idp_provider_repo.create_provider(
        db_session, slug="two-portal", display_name="Portal",
        kind="custom_profile",
        settings={"source": "cookie", "source_key": "corp_profile",
                  "payload_format": "jwt", "shared_secret": "s" * 48},
    )
    await db_session.commit()

    refs = set()
    for _ in range(3):
        resp = await test_client.get(
            "/api/v1/auth/two-portal/login", follow_redirects=False,
        )
        refs.add(re.search(r"ref=([0-9a-f]{8})", resp.headers["location"]).group(1))
    assert len(refs) == 3


# ── The lens ─────────────────────────────────────────────────────────


def test_sso_category_narrows_rather_than_subtracts():
    """The other categories hide noisy event types from the full audit
    prefix set. ``sso`` instead narrows the prefix set and hides nothing —
    every event under those prefixes is on-topic for debugging a sign-in."""
    assert _HIDE_BY_CATEGORY["sso"] == frozenset()
    assert _SSO_PREFIXES


@pytest.mark.parametrize("event_type", [
    "idp.provider.created",
    "auth.config.updated",
    "rbac.sso_mapping.created",
    "user.sso_provisioned",
    "user.sso_login_failed",
    "user.identity.linked",
    "user.logged_in",
])
def test_sso_prefixes_cover_the_identity_surface(event_type):
    assert any(event_type.startswith(p) for p in _SSO_PREFIXES), event_type


@pytest.mark.parametrize("event_type", [
    # A role rename is an audit event but it is not an SSO event. Including
    # the bare ``user.``/``rbac.`` prefixes would put this view back in the
    # haystack it exists to escape.
    "user.role_changed",
    "user.approved",
    "user.access_denied",
    "rbac.workspace.member_bound",
    "rbac.role.created",
])
def test_sso_prefixes_exclude_the_wider_rbac_surface(event_type):
    assert not any(event_type.startswith(p) for p in _SSO_PREFIXES), event_type


@pytest.mark.asyncio
async def test_the_endpoint_returns_only_sso_events(test_client, db_session):
    """End to end: seed a mixed bag, ask for category=sso, get the identity
    surface and nothing else."""
    from backend.app.db.repositories import user_repo

    for event_type in (
        "idp.provider.created",
        "user.sso_login_failed",
        "user.role_changed",          # audit-worthy, not SSO
        "rbac.workspace.created",     # audit-worthy, not SSO
    ):
        await user_repo.create_outbox_event(
            db_session, event_type=event_type, payload={"ref": "deadbeef"},
        )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/audit?category=sso&limit=50")
    assert resp.status_code == 200
    types = {e["eventType"] for e in resp.json()["events"]}
    assert "idp.provider.created" in types
    assert "user.sso_login_failed" in types
    assert "user.role_changed" not in types
    assert "rbac.workspace.created" not in types


# ── Summaries ────────────────────────────────────────────────────────


def test_the_failure_summary_leads_with_the_reference():
    """An admin pastes the ref and scans the column — it has to be the first
    thing on the line, not buried in a payload blob."""
    severity, build = _EVENT_META["user.sso_login_failed"]
    assert severity == "warning"
    line = build({"ref": "a1b2c3d4", "provider_slug": "okta",
                  "reason": "payload_expired"})
    assert line.startswith("[a1b2c3d4]")
    assert "okta" in line and "payload_expired" in line


@pytest.mark.parametrize("event_type", [
    "user.sso_unsigned_accepted",
    "user.sso_header_accepted",
])
def test_degraded_trust_logins_are_warnings_not_info(event_type):
    """These are successful logins the platform could not verify. Rendering
    them at the same weight as an ordinary sign-in would bury exactly the
    thing an auditor is scanning for."""
    severity, _build = _EVENT_META[event_type]
    assert severity == "warning"


@pytest.mark.parametrize("event_type", [
    "user.sso_login_failed",
    "user.sso_provisioned",
    "user.sso_linked",
    "user.sso_link_denied",
    "user.sso_jit_blocked",
    "user.sso_session_expired",
    "user.sso_unsigned_accepted",
    "user.sso_header_accepted",
])
def test_every_sso_event_renders_from_an_empty_payload(event_type):
    """Summary builders run inside response serialisation, so a malformed or
    partial payload must degrade to a readable line rather than raise."""
    _severity, build = _EVENT_META[event_type]
    line = build({})
    assert isinstance(line, str) and line.strip()


# ── Actor attribution ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_idp_provider_events_carry_an_actor(test_client, db_session):
    """These events wrote ``actor``; the audit reader looks for ``actor_id``.
    Every IdP provider change therefore rendered with no actor at all —
    an audit trail that does not say who did it."""
    resp = await test_client.post(
        "/api/v1/admin/idp-providers",
        json={"slug": "actor-test", "displayName": "Actor Test",
              "kind": "oidc",
              "settings": {"issuer": "https://idp", "client_id": "c",
                           "client_secret": "s",
                           "redirect_uri": "https://app/cb"}},
    )
    assert resp.status_code == 201, resp.text

    audit = await test_client.get(
        "/api/v1/admin/audit?category=sso&eventType=idp.provider.created",
    )
    assert audit.status_code == 200
    events = audit.json()["events"]
    assert events, "provider creation was not audited"
    assert events[0]["actorId"], "audit row has no actor"
