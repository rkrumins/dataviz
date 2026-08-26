"""A misconfigured provider should say what is wrong, once, to the right
person.

Every provider builder validates its row and raises with the exact
sentence an operator needs — which field is missing, which combination
cannot work. Nothing caught it. The row saved happily, and the failure
first surfaced at somebody's sign-in as ``500 Internal server error``,
because ``_resolve_provider`` catches ``ProviderNotFound``,
``ProviderDisabled`` and ``RuntimeError`` and nothing else.

So the message was written and thrown away, twice over: the operator
never saw it, and the user got a 500 that told them nothing either.

The fix splits by audience, and the split is the point:

* **the operator, at save time** — a 400 carrying the real reason, at
  the moment they can act on it;
* **the user, at sign-in** — the same generic answer an unknown provider
  gets, because that route is public and the reason names settings
  fields.
"""
from __future__ import annotations

import pytest

from backend.app.db.repositories import idp_provider_repo

_ADMIN = "/api/v1/admin/idp-providers"

_GOOD_BACKCHANNEL = {
    "token_source": "cookie", "token_source_key": "corp_session",
    "gateway_url": "https://gw.corp.example/redeem",
    "gateway_send_as": "cookie",
    "gateway_token_path": "access_token",
}


async def _create(client, **over):
    body = {
        "slug": "corp-gateway", "displayName": "Corporate Gateway",
        "kind": "backchannel", "settings": dict(_GOOD_BACKCHANNEL),
    }
    body.update(over)
    return await client.post(_ADMIN, json=body)


# ── the operator, at save time ───────────────────────────────────────

@pytest.mark.asyncio
async def test_a_good_row_saves(test_client):
    """The control. Without it every assertion below could pass because
    creation is simply broken."""
    assert (await _create(test_client)).status_code == 201


@pytest.mark.asyncio
async def test_a_missing_required_field_is_a_400_naming_it(test_client):
    resp = await _create(test_client, settings={"token_source_key": "x"})
    assert resp.status_code == 400
    assert "gateway_url" in resp.text


@pytest.mark.asyncio
async def test_an_impossible_combination_is_a_400_explaining_it(test_client):
    """Not merely "invalid". A GET cannot carry a body, so the token
    would never be sent — and an operator staring at a form has no way
    to deduce that from a rejection."""
    resp = await _create(test_client, settings={
        **_GOOD_BACKCHANNEL,
        "gateway_send_as": "body", "gateway_body_field": "sessionId",
        "gateway_method": "GET",
    })
    assert resp.status_code == 400
    assert "GET" in resp.text


@pytest.mark.asyncio
async def test_a_rejected_row_is_not_stored(test_client, db_session):
    """Validation runs BEFORE the write rather than writing and relying
    on the request's rollback. That matters beyond tidiness: the shared
    test session commits nothing and rolls back nothing (see the note in
    conftest), so a rollback-based guarantee would be untestable here —
    and a guarantee nothing can check is one that quietly stops
    holding."""
    await _create(test_client, settings={"token_source_key": "x"})
    rows = await idp_provider_repo.list_providers(db_session)
    assert [r.slug for r in rows if r.slug == "corp-gateway"] == []


@pytest.mark.asyncio
async def test_a_placeholder_draft_with_no_settings_is_allowed(test_client):
    """A row can legitimately be created empty and filled in
    afterwards — that is how every kind without discovery is set up.
    Refusing it would make the connection wizard impossible."""
    assert (await _create(test_client, settings={})).status_code == 201


@pytest.mark.asyncio
async def test_breaking_a_row_by_editing_it_is_refused(test_client):
    """PATCH merges, so an edit that empties one required field has to
    be judged against the whole merged result rather than the fragment
    that was sent."""
    created = await _create(test_client)
    provider_id = created.json()["id"]

    resp = await test_client.patch(
        f"{_ADMIN}/{provider_id}",
        json={"settings": {"gateway_send_as": "header",
                           "gateway_token_header": ""}},
    )
    assert resp.status_code == 400
    assert "token_header" in resp.text


@pytest.mark.asyncio
async def test_an_edit_that_keeps_the_row_working_is_accepted(test_client):
    created = await _create(test_client)
    resp = await test_client.patch(
        f"{_ADMIN}/{created.json()['id']}",
        json={"settings": {"timeout_seconds": 9}},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_publishing_an_empty_placeholder_is_refused(test_client):
    """Stricter than create on purpose: a draft may be a placeholder,
    but a live provider is on the login page for everyone and must
    actually work."""
    created = await _create(test_client, settings={})
    resp = await test_client.post(f"{_ADMIN}/{created.json()['id']}/publish")
    assert resp.status_code == 400
    # Whichever required field the builder reaches first — the point is
    # that a name appears at all, rather than "invalid configuration".
    assert "token_source_key" in resp.text


@pytest.mark.asyncio
async def test_publishing_a_working_row_succeeds(test_client):
    created = await _create(test_client)
    resp = await test_client.post(f"{_ADMIN}/{created.json()['id']}/publish")
    assert resp.status_code == 200


# ── the same guard covers the kind that had the problem first ────────

@pytest.mark.asyncio
async def test_custom_profile_gets_the_same_treatment(test_client):
    """This is not a back-channel feature. ``custom_profile`` has raised
    a config error since it shipped, with nobody catching it either."""
    resp = await _create(
        test_client, kind="custom_profile", slug="corp-portal",
        settings={"source": "cookie", "source_key": "corp_profile",
                  "payload_format": "json"},
    )
    assert resp.status_code == 400
    assert "trust_unsigned" in resp.text


@pytest.mark.asyncio
async def test_a_kind_with_no_builder_is_left_alone(test_client):
    """``local`` has no entry in PROVIDER_BUILDERS and neither will the
    next kind on the day it is half-registered. Refusing to save one is
    not this guard's job."""
    resp = await _create(
        test_client, kind="custom", slug="dev-mock",
        settings={"anything": "goes"},
    )
    assert resp.status_code == 201


# ── the user, at sign-in ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_broken_row_answers_the_generic_404_not_a_500(
    test_client, db_session, registry,
):
    """The row is written straight to the repo, bypassing the admin
    guard — which is exactly the state a deployment lands in when a row
    predates the guard, or is edited in the database."""
    row = await idp_provider_repo.create_provider(
        db_session, slug="broken-gateway", display_name="Broken",
        kind="backchannel", settings={"token_source_key": "x"},
        claim_mapping={},
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/auth/broken-gateway/login", follow_redirects=False,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_the_public_answer_does_not_name_the_broken_setting(
    test_client, db_session, registry,
):
    """The operator's copy of the reason is the 400 above, where they
    can act on it. This route is public, and the message names settings
    fields — a stranger probing slugs should not be able to read a
    provider's configuration back out of its error."""
    row = await idp_provider_repo.create_provider(
        db_session, slug="broken-gateway", display_name="Broken",
        kind="backchannel", settings={"token_source_key": "x"},
        claim_mapping={},
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/auth/broken-gateway/login", follow_redirects=False,
    )
    assert "gateway_url" not in resp.text
    assert "token_source_key" not in resp.text


@pytest.mark.asyncio
async def test_the_snapshot_lookup_fails_the_same_way(
    test_client, db_session, registry,
):
    """``_provider_snapshot`` needs the same catch, and not for symmetry:
    BOTH ``resolve_slug`` and ``get_snapshot`` build the provider on a
    cache miss, so a "snapshot" lookup is not the read-only operation
    its name suggests. Reached directly by the callback and ACS routes.
    """
    row = await idp_provider_repo.create_provider(
        db_session, slug="broken-portal", display_name="Broken",
        kind="custom_profile",
        settings={"source": "cookie", "source_key": "p",
                  "payload_format": "json"},
        claim_mapping={},
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()

    resp = await test_client.post(
        "/api/v1/auth/broken-portal/browser-profile", json={"payload": "x"},
    )
    assert resp.status_code == 404
    assert "trust_unsigned" not in resp.text


@pytest.mark.asyncio
async def test_one_broken_row_does_not_take_down_the_login_page(
    test_client, db_session, registry,
):
    """The public catalog lists snapshots without building them, so a
    single unusable row must not empty everyone's sign-in page. Pinning
    it because the fix above could plausibly have been written as
    "build everything defensively", which would have."""
    good = await idp_provider_repo.create_provider(
        db_session, slug="working-oidc", display_name="Works", kind="oidc",
        settings={"issuer": "https://idp", "client_id": "c",
                  "client_secret": "s", "redirect_uri": "https://app/cb"},
        claim_mapping={},
    )
    await idp_provider_repo.publish_provider(db_session, good.id)
    bad = await idp_provider_repo.create_provider(
        db_session, slug="broken-gateway", display_name="Broken",
        kind="backchannel", settings={"token_source_key": "x"},
        claim_mapping={},
    )
    await idp_provider_repo.publish_provider(db_session, bad.id)
    await db_session.commit()

    resp = await test_client.get("/api/v1/auth/providers")
    assert resp.status_code == 200
    assert "working-oidc" in [p["slug"] for p in resp.json()]
