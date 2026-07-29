"""The public catalog's field names, which the login page reads directly.

``ProviderSummary`` was the one DTO in this API serialised snake_case,
while the login page — its only consumer — reads ``displayName`` and
``buttonLabel``. Every SSO button therefore rendered with no text in it:
an empty outline under "Or sign in with", clickable but unlabelled, and
on the light theme not even visibly an outline.

Nothing caught it. The frontend tests mock the service with camelCase
objects, so they exercise the shape the page *expects* rather than the
one the server sends; the backend tests asserted on ``slug``, which is
spelled the same either way. This file asserts the contract itself.
"""
import pytest

from backend.app.db.repositories import idp_provider_repo
from backend.app.db.repositories.idp_provider_repo import ProviderValidationError


async def _live_provider(db_session, *, slug, **over):
    row = await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=over.pop("display_name", "Corp SSO"),
        kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
        lifecycle="live", enabled=True, **over,
    )
    await db_session.commit()
    return row


@pytest.mark.asyncio
async def test_the_catalog_names_its_fields_the_way_the_page_reads_them(
    test_client, db_session, registry,
):
    await _live_provider(db_session, slug="corp", display_name="Corp SSO")
    resp = await test_client.get("/api/v1/auth/providers")
    assert resp.status_code == 200, resp.text

    entry = next(p for p in resp.json() if p["slug"] == "corp")
    assert entry["displayName"] == "Corp SSO"
    # The button label is what the page renders, so its absence is not a
    # cosmetic difference — it is a control with no name.
    assert "buttonLabel" in entry
    assert "buttonIcon" in entry
    assert "display_name" not in entry


@pytest.mark.asyncio
async def test_login_context_carries_the_same_shape(
    test_client, db_session, registry,
):
    """The route the login page actually calls. It nests the same model,
    and nesting is exactly where a by-alias setting is easy to lose."""
    await _live_provider(db_session, slug="ctx", display_name="Context SSO")
    resp = await test_client.get("/api/v1/auth/login-context")
    assert resp.status_code == 200, resp.text

    body = resp.json()
    assert body["allowLocalLogin"] is not None
    entry = next(p for p in body["providers"] if p["slug"] == "ctx")
    assert entry["displayName"] == "Context SSO"
    assert "display_name" not in entry


@pytest.mark.asyncio
async def test_an_edit_cannot_blank_a_name_a_create_refused(db_session):
    """The two write paths disagreed.

    ``create_provider`` refuses a blank display name; ``update_provider``
    stripped and stored whatever it was handed. So a connection could be
    left nameless by editing it, and the login page would fall back to
    calling it by its slug.
    """
    row = await _live_provider(db_session, slug="named", display_name="Named")

    with pytest.raises(ProviderValidationError):
        await idp_provider_repo.update_provider(
            db_session, row.id, display_name="   ",
        )


@pytest.mark.asyncio
async def test_a_real_rename_still_goes_through(db_session):
    """The guard must not cost operators the ordinary edit."""
    row = await _live_provider(db_session, slug="renamed", display_name="Old")

    updated = await idp_provider_repo.update_provider(
        db_session, row.id, display_name="  New Name  ",
    )
    assert updated.display_name == "New Name"
