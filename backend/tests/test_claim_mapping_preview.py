"""Previewing a claim mapping — with and without a provider row.

Two things are pinned here.

**Preview must work before a row exists.** ``/{id}/test`` needs a saved
provider, which meant the setup wizard's mapping step could never preview:
the draft is not created until the rehearse step that follows it. An
operator writing a mapping was told the preview ran against a real payload
while the button sat disabled. ``/preview-mapping`` is the fix, and the
regression is asserted at the API rather than only through the component,
because that is the layer the guarantee lives at.

**Provenance must agree with the mapper.** ``resolvedFrom`` says which
candidate key actually supplied each field. Getting the winner wrong is
worse than omitting it — it teaches the operator the wrong claim name with
the authority of a live preview.
"""
from __future__ import annotations

import pytest

from backend.app.db.repositories import idp_provider_repo
from backend.auth_service.providers import resolved_sources

PREVIEW = "/api/v1/admin/idp-providers/preview-mapping"


# ── The regression: no provider row ───────────────────────────────────


@pytest.mark.asyncio
async def test_previews_a_mapping_with_no_provider_saved(test_client):
    # The wizard's step 3. Nothing has been created yet.
    resp = await test_client.post(PREVIEW, json={
        "kind": "oidc",
        "claims": {"sub": "u-1", "email": "alice@corp.example",
                   "given_name": "Alice", "family_name": "Doe"},
    })
    assert resp.status_code == 200, resp.text
    resolved = resp.json()["resolved"]
    assert resolved["external_id"] == "u-1"
    assert resolved["email"] == "alice@corp.example"
    assert resolved["first_name"] == "Alice"


@pytest.mark.asyncio
async def test_an_override_is_honoured_without_a_row_to_read_it_from(test_client):
    # The whole point of previewing while editing: the mapping under test
    # is the one in the form, not one that has been saved anywhere.
    resp = await test_client.post(PREVIEW, json={
        "kind": "custom_profile",
        "claims": {"employeeId": "12345", "workEmail": "bob@corp.example"},
        "override": {"external_id": ["employeeId"], "email": ["workEmail"]},
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["resolved"]["external_id"] == "12345"
    assert resp.json()["resolved"]["email"] == "bob@corp.example"


@pytest.mark.asyncio
async def test_a_required_field_that_will_not_resolve_is_a_400(test_client):
    # Same contract as /test — the operator needs the reason, not a 500.
    resp = await test_client.post(PREVIEW, json={
        "kind": "oidc",
        "claims": {"sub": "u-1"},
    })
    assert resp.status_code == 400
    assert "email" in resp.json()["detail"]


# ── Provenance ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reports_which_candidate_key_won(test_client):
    # Two candidates present. Only the first is doing any work, and an
    # operator maintaining the other three deserves to know that.
    resp = await test_client.post(PREVIEW, json={
        "kind": "custom_profile",
        "claims": {"sub": "u-1", "emailAddress": "a@corp.example",
                   "email": "wrong@corp.example"},
        "override": {"email": ["emailAddress", "email", "mail"]},
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["resolvedFrom"]["email"] == "emailAddress"
    assert resp.json()["resolved"]["email"] == "a@corp.example"


@pytest.mark.asyncio
async def test_an_unresolved_field_is_reported_as_null_not_omitted(test_client):
    # Absent would be indistinguishable from "we forgot to report it".
    resp = await test_client.post(PREVIEW, json={
        "kind": "oidc",
        "claims": {"sub": "u-1", "email": "a@corp.example"},
    })
    body = resp.json()["resolvedFrom"]
    assert "groups" in body and body["groups"] is None


@pytest.mark.asyncio
async def test_provenance_follows_dotted_paths(test_client):
    # The reason this is computed server-side: a naive claims.get(path)
    # would miss this, and then disagree with the login that succeeds.
    resp = await test_client.post(PREVIEW, json={
        "kind": "custom_profile",
        "claims": {"sub": "u-1", "user": {"mail": "nested@corp.example"}},
        "override": {"email": ["user.mail"]},
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["resolvedFrom"]["email"] == "user.mail"
    assert resp.json()["resolved"]["email"] == "nested@corp.example"


@pytest.mark.asyncio
async def test_extras_carry_provenance_too(test_client):
    resp = await test_client.post(PREVIEW, json={
        "kind": "custom_profile",
        "claims": {"sub": "u-1", "email": "a@corp.example", "staffNo": "99"},
        "override": {"extras": {"staff_id": ["employeeId", "staffNo"]}},
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["resolvedFrom"]["extras.staff_id"] == "staffNo"


@pytest.mark.asyncio
async def test_a_split_name_is_reported_as_derived_not_as_nothing(test_client):
    """The screen would otherwise contradict the login it is configuring.

    An IdP releasing only ``name`` produces both names via the display-name
    split, but none of *their* candidates fired — so ``resolvedFrom`` is
    null for each, and the pane read that as "nothing resolved" beside two
    populated values.
    """
    resp = await test_client.post(PREVIEW, json={
        "kind": "oidc",
        "claims": {"sub": "u-1", "email": "a@corp.example", "name": "Alice Doe"},
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["resolved"]["first_name"] == "Alice"
    assert body["resolved"]["last_name"] == "Doe"
    assert body["resolvedFrom"]["first_name"] is None
    assert body["namesDerivedFrom"] == "name"


@pytest.mark.asyncio
async def test_names_the_idp_asserted_are_not_reported_as_derived(test_client):
    resp = await test_client.post(PREVIEW, json={
        "kind": "oidc",
        "claims": {
            "sub": "u-1", "email": "a@corp.example",
            "given_name": "Alice", "family_name": "Doe",
        },
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["namesDerivedFrom"] is None
    assert resp.json()["resolvedFrom"]["first_name"] == "given_name"


# ── The saved path keeps its shape, and gains provenance ──────────────


@pytest.mark.asyncio
async def test_the_saved_provider_route_still_works_and_now_says_where(
    test_client, db_session,
):
    row = await idp_provider_repo.create_provider(
        db_session, slug="saved-preview", display_name="Saved", kind="oidc",
        settings={"issuer": "https://idp"},
    )
    await db_session.commit()

    resp = await test_client.post(
        f"/api/v1/admin/idp-providers/{row.id}/test",
        json={"claims": {"sub": "u-1", "email": "a@corp.example"},
              "override": {"external_id": ["sub"], "email": ["email"]}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The id is still on the response — existing callers key off it.
    assert body["providerId"] == row.id
    assert body["resolvedFrom"]["email"] == "email"


# ── The helper itself ─────────────────────────────────────────────────


def test_resolved_sources_skips_a_candidate_that_is_present_but_empty():
    # _first_non_empty treats "" and [] as absent. Provenance has to agree,
    # or it would name a key that supplied nothing.
    out = resolved_sources(
        {"a": "", "b": [], "c": "value"},
        kind="custom_profile",
        override={"email": ["a", "b", "c"]},
    )
    assert out["email"] == "c"


def test_resolved_sources_reports_none_when_nothing_matches():
    out = resolved_sources(
        {"sub": "u-1"}, kind="oidc", override={"email": ["nope"]},
    )
    assert out["email"] is None


@pytest.mark.asyncio
async def test_a_backchannel_preview_hoists_like_the_sign_in_does(test_client):
    """The gateway kinds hoist one level of container nesting at sign-in.
    A preview that skipped the hoist called a nested payload unmappable
    while the real sign-in mapped it fine — lying in the pessimistic
    direction, which teaches operators to ignore the preview."""
    resp = await test_client.post(PREVIEW, json={
        "kind": "backchannel",
        "claims": {
            "groups": [],
            "profile": {
                "sub": "emp-1", "email": "ada@corp.example",
                "firstName": "Ada", "lastName": "Lovelace",
                "groups": ["eng", "analytics"],
            },
        },
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["resolved"]["email"] == "ada@corp.example"
    # Both halves of the fix: the empty top-level list does not shadow,
    # and provenance reports against the same hoisted view.
    assert body["resolved"]["groups"] == ["eng", "analytics"]
    assert body["resolvedFrom"]["groups"] == "groups"


@pytest.mark.asyncio
async def test_the_preview_reports_the_avatar_like_the_login_maps_it(
    test_client,
):
    """Preview parity for the avatar claim: the same candidates, and the
    same provenance reporting, as the sign-in itself."""
    resp = await test_client.post(PREVIEW, json={
        "kind": "backchannel",
        "claims": {"sub": "u-1", "email": "a@corp.example",
                   "picture": "https://sso.corp.example/a.png"},
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["resolved"]["avatar_url"] == "https://sso.corp.example/a.png"
    assert body["resolvedFrom"]["avatar_url"] == "picture"
