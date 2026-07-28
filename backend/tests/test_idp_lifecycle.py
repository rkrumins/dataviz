"""Draft until proved: a provider reaches nobody until it is published.

Creating a provider used to put it on every user's login page the instant
it was saved — before discovery had been reviewed, before a dry-run had
shown what it would do, before anyone had checked the certificate. The
setup flow's promise is "nothing is live until you press publish", and
this is the file that makes the promise true rather than aspirational.

The visibility assertions deliberately cover BOTH public surfaces.
``/auth/providers`` and ``/auth/login-context`` are separate endpoints that
each decide what the world may see, and a guard on one is not a guard.
"""
from __future__ import annotations

import pytest

from backend.app.db.repositories import idp_provider_repo


async def _provider(db_session, *, slug, lifecycle="draft", enabled=True):
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
        lifecycle=lifecycle, enabled=enabled,
    )
    await db_session.commit()
    return row


# ── The default ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_new_provider_starts_as_a_draft(db_session):
    row = await _provider(db_session, slug="fresh")
    assert row.lifecycle == "draft"


@pytest.mark.asyncio
async def test_creating_through_the_api_also_starts_as_a_draft(
    test_client, db_session,
):
    """The endpoint is what the setup flow calls, so the default has to
    hold there and not only in the repo."""
    resp = await test_client.post("/api/v1/admin/idp-providers", json={
        "slug": "api-fresh", "displayName": "API Fresh", "kind": "oidc",
        "settings": {"issuer": "https://idp"},
    })
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["lifecycle"] == "draft"


# ── Invisibility, on every public surface ────────────────────────────


@pytest.mark.asyncio
async def test_a_draft_is_absent_from_the_login_catalog(
    test_client, db_session, registry,
):
    await _provider(db_session, slug="draft-cat")
    resp = await test_client.get("/api/v1/auth/providers")
    assert resp.status_code == 200
    assert "draft-cat" not in [p["slug"] for p in resp.json()]


@pytest.mark.asyncio
async def test_a_draft_is_absent_from_login_context_too(
    test_client, db_session, registry,
):
    """The second public surface. It reads the same catalog helper, and
    this asserts that it still does."""
    await _provider(db_session, slug="draft-ctx")
    resp = await test_client.get("/api/v1/auth/login-context")
    assert resp.status_code == 200
    assert "draft-ctx" not in [p["slug"] for p in resp.json()["providers"]]


@pytest.mark.asyncio
async def test_a_draft_does_not_answer_email_domain_routing(db_session):
    """Email-first routing is a third way a provider becomes visible —
    it hands back a provider to an anonymous caller."""
    await idp_provider_repo.create_provider(
        db_session, slug="draft-hrd", display_name="d", kind="oidc",
        settings={"issuer": "https://idp"},
        email_domains=["corp.example"], lifecycle="draft",
    )
    await db_session.commit()
    found = await idp_provider_repo.find_by_email_domain(
        db_session, "corp.example",
    )
    assert found is None


# ── But still fully rehearsable ──────────────────────────────────────


@pytest.mark.asyncio
async def test_a_draft_can_still_be_rehearsed(test_client, db_session):
    """The whole point: prove it before you publish it. If a draft could
    not be dry-run, the order of operations would be impossible."""
    row = await _provider(db_session, slug="draft-rehearse")
    resp = await test_client.post(
        f"/api/v1/admin/idp-providers/{row.id}/dry-run/start",
    )
    assert resp.status_code == 200, resp.text
    assert resp.cookies.get("nx_dryrun")


@pytest.mark.asyncio
async def test_a_draft_is_visible_to_the_admin_who_owns_it(
    test_client, db_session,
):
    await _provider(db_session, slug="draft-admin")
    resp = await test_client.get("/api/v1/admin/idp-providers")
    assert "draft-admin" in [p["slug"] for p in resp.json()]


# ── Publishing ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_publishing_makes_it_public(test_client, db_session, registry):
    row = await _provider(db_session, slug="to-publish")

    resp = await test_client.post(
        f"/api/v1/admin/idp-providers/{row.id}/publish",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["lifecycle"] == "live"

    catalog = await test_client.get("/api/v1/auth/providers")
    assert "to-publish" in [p["slug"] for p in catalog.json()]


@pytest.mark.asyncio
async def test_publishing_twice_is_not_an_error(test_client, db_session):
    """A double-click, or a retried request, must not fail."""
    row = await _provider(db_session, slug="twice")
    first = await test_client.post(f"/api/v1/admin/idp-providers/{row.id}/publish")
    second = await test_client.post(f"/api/v1/admin/idp-providers/{row.id}/publish")
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["lifecycle"] == "live"


@pytest.mark.asyncio
async def test_publishing_an_unknown_provider_is_a_404(test_client):
    resp = await test_client.post("/api/v1/admin/idp-providers/idp_nope/publish")
    assert resp.status_code == 404


# ── Readiness and operational state stay separate ────────────────────


@pytest.mark.asyncio
async def test_a_published_but_disabled_provider_stays_hidden(
    test_client, db_session, registry,
):
    """``enabled`` is the incident switch; ``lifecycle`` is readiness.
    Turning a live provider off must still hide it — otherwise the new
    column would have quietly widened what the public can see."""
    await _provider(db_session, slug="live-off", lifecycle="live", enabled=False)
    resp = await test_client.get("/api/v1/auth/providers")
    assert "live-off" not in [p["slug"] for p in resp.json()]


# ── The upgrade hazard ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_repo_default_keeps_existing_deployments_serving(db_session):
    """The boot seeder migrates env-var deployments (``OIDC_*``, ``SAML_*``)
    into provider rows on startup. Those IdPs are already serving traffic.

    If the repo defaulted to ``draft``, upgrading would silently switch SSO
    off for every env-based deployment — the same failure the migration's
    ``server_default='live'`` exists to avoid, arriving through a different
    door. The draft policy lives at the admin endpoint, where the actor is a
    human, not here.
    """
    row = await idp_provider_repo.create_provider(
        db_session, slug="seeded-by-boot", display_name="Seeded", kind="oidc",
        settings={"issuer": "https://idp"},
    )
    assert row.lifecycle == "live"
