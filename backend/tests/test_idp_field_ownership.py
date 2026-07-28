"""Which profile fields the IdP owns, and what that ownership means.

"The IdP is the source of truth" has two halves, and a system that
implements only the first has neither:

  * the field is refused on the way in, and
  * the field is re-applied on every sign-in.

A read-only field that nothing refreshes is not owned by anybody — it is
a stale local copy that nobody is allowed to correct. Before this,
``complete_sso_login`` wrote names once at JIT provisioning and never
again, so the profile drifted from the directory forever.

The other half of the design is that ownership is claimed per login from
what the IdP actually sent, not inferred from a linked identity existing.
An IdP that releases no ``given_name`` must leave the field editable,
or its users get a blank name they can never fill in.
"""
import json

import pytest
from httpx import AsyncClient

from backend.app.db.repositories import user_repo
from backend.common.identity_provenance import (
    asserted_fields,
    build_snapshot,
    managed_fields,
    managing_provider_id,
    merge_into_metadata,
    snapshot_key,
)

_ME = "usr_test000000"


# ── What a login claims ──────────────────────────────────────────────

@pytest.mark.parametrize("first,last,expected", [
    ("Ada", "Lovelace", ["first_name", "last_name"]),
    ("Ada", "", ["first_name"]),
    ("", "Lovelace", ["last_name"]),
    ("", "", []),
    (None, None, []),
    ("   ", "  ", []),
])
def test_only_fields_the_idp_actually_sent_are_claimed(first, last, expected):
    """Whitespace is not an assertion.

    The blank cases are the whole reason this is per-field: an IdP that
    releases no given_name must not end up owning — and permanently
    blanking — a field it never had a value for.
    """
    assert asserted_fields(first_name=first, last_name=last) == expected


# ── Reading the snapshot back ────────────────────────────────────────

def test_snapshot_round_trips():
    meta = merge_into_metadata(
        {"idp_groups": ["eng"]},
        build_snapshot(fields=["first_name"], provider_id="idp_1", at="2026-07-28T00:00:00Z"),
    )
    assert managed_fields(meta) == frozenset({"first_name"})
    assert managing_provider_id(meta) == "idp_1"
    # Merging must not disturb the rest of the document.
    assert meta["idp_groups"] == ["eng"]


@pytest.mark.parametrize("meta", [
    None, {}, {snapshot_key(): None}, {snapshot_key(): "nonsense"},
    {snapshot_key(): {"fields": "first_name"}},
    {snapshot_key(): {}},
])
def test_unreadable_snapshots_claim_nothing(meta):
    """Fails open, deliberately.

    A malformed metadata blob should cost a user the lock, not the
    ability to edit their own name.
    """
    assert managed_fields(meta) == frozenset()


def test_unknown_field_names_are_ignored():
    """The snapshot cannot widen its own remit — ``email`` and
    ``display_name`` are never IdP-owned, whatever a blob claims."""
    meta = {snapshot_key(): {"fields": ["first_name", "email", "display_name"]}}
    assert managed_fields(meta) == frozenset({"first_name"})


# ── Enforcement ──────────────────────────────────────────────────────

async def _mark_managed(db_session, fields, provider_id="idp_okta"):
    user = await user_repo.get_user_by_id(db_session, _ME)
    meta = json.loads(user.metadata_ or "{}")
    user.metadata_ = json.dumps(merge_into_metadata(
        meta, build_snapshot(fields=fields, provider_id=provider_id, at="2026-07-28T00:00:00Z"),
    ))
    await db_session.flush()


async def test_local_account_can_edit_everything(test_client: AsyncClient):
    """No snapshot means no owner. A local profile stays fully editable."""
    resp = await test_client.patch(
        "/api/v1/users/me", json={"firstName": "Local", "lastName": "Owner"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["firstName"] == "Local"


async def test_idp_owned_name_is_refused(test_client: AsyncClient, db_session):
    """Refused, not silently dropped — a form that discards what you
    typed and reports success is worse than one that says no."""
    await _mark_managed(db_session, ["first_name", "last_name"])

    resp = await test_client.patch("/api/v1/users/me", json={"firstName": "Nope"})
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "idp_managed_field"
    assert detail["fields"] == ["first_name"]


async def test_unowned_fields_stay_editable_alongside_owned_ones(
    test_client: AsyncClient, db_session,
):
    """Partial ownership is the common case: an IdP sends given_name and
    nothing else. The surname must remain the user's to set."""
    await _mark_managed(db_session, ["first_name"])

    resp = await test_client.patch("/api/v1/users/me", json={"lastName": "Editable"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["lastName"] == "Editable"


async def test_display_name_is_never_idp_owned(test_client: AsyncClient, db_session):
    """The escape hatch. If this ever locks, an SSO user has no way to
    change how their name appears — and the page stops being useful."""
    await _mark_managed(db_session, ["first_name", "last_name"])

    resp = await test_client.patch("/api/v1/users/me", json={"displayName": "Ada"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["displayName"] == "Ada"


async def test_ownership_is_reported_to_the_client(
    test_client: AsyncClient, db_session,
):
    """The UI renders these read-only, so it has to be told which."""
    await _mark_managed(db_session, ["first_name"], provider_id="idp_entra")

    body = (await test_client.get("/api/v1/users/me")).json()
    assert body["idpManagedFields"] == ["first_name"]
    assert body["idpManagedBy"] == "idp_entra"


async def test_admin_edit_is_refused_too(test_client: AsyncClient, db_session):
    """Being an admin does not make the write survive the next sign-in."""
    await _mark_managed(db_session, ["first_name"])

    resp = await test_client.patch(
        f"/api/v1/admin/users/{_ME}", json={"firstName": "Override"},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["error"] == "idp_managed_field"


async def test_admin_can_still_set_a_display_name(
    test_client: AsyncClient, db_session,
):
    """The supported way to fix how an SSO user's name reads."""
    await _mark_managed(db_session, ["first_name", "last_name"])

    resp = await test_client.patch(
        f"/api/v1/admin/users/{_ME}", json={"displayName": "Ada L."},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["displayName"] == "Ada L."


async def test_a_provider_that_stops_asserting_hands_the_field_back(
    test_client: AsyncClient, db_session,
):
    """The snapshot is replaced per login, not merged.

    An operator who removes given_name from the claim mapping should see
    the field become editable again at the next sign-in, not stay locked
    on the strength of a login from six months ago.
    """
    await _mark_managed(db_session, ["first_name"])
    assert (await test_client.patch(
        "/api/v1/users/me", json={"firstName": "Blocked"},
    )).status_code == 409

    await _mark_managed(db_session, [])          # next login asserts nothing

    resp = await test_client.patch("/api/v1/users/me", json={"firstName": "Freed"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["firstName"] == "Freed"


# ── Re-sync: the half that makes ownership mean something ────────────
#
# Driven through the real ``complete_sso_login`` rather than a stub,
# because the regression being guarded is precisely that the login path
# wrote names once and never revisited them. Harness mirrors
# ``test_sso_phase4.py``.

from contextlib import asynccontextmanager

from backend.app.db.repositories import idp_provider_repo, user_identity_repo
from backend.auth_service.app_auth_config import (
    AuthConfigSnapshot, StaticAuthConfigProvider,
)
from backend.auth_service.providers.base import ProviderIdentity
from backend.auth_service.service import LocalIdentityService


@pytest.fixture()
async def sso_provider(db_session):
    row = await idp_provider_repo.create_provider(
        db_session,
        slug="ownership-idp", display_name="Ownership IdP", kind="oidc",
        settings={
            "issuer": "https://idp.example.com", "client_id": "c",
            "client_secret": "s", "redirect_uri": "https://app/cb",
            "scopes": "openid email",
        },
        claim_mapping={}, linking_policy="strict",
    )
    await db_session.flush()
    return row


def _svc(db_session):
    @asynccontextmanager
    async def factory():
        yield db_session

    async def outbox(session, event_type, payload):
        return None

    return LocalIdentityService(
        session_factory=factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=lambda s: None,
        outbox_emit=outbox,
        claims_resolver=None,
        auth_config_provider=StaticAuthConfigProvider(AuthConfigSnapshot(
            sso_enabled=True, allow_local_login=True,
            allow_jit_provisioning=True, version=1,
            updated_at="2026-01-01T00:00:00Z",
        )),
    )


def _identity(**over) -> ProviderIdentity:
    base = dict(
        provider="oidc", external_id="sub-own", email="owned@corp.com",
        first_name="Ada", last_name="Lovelace",
        raw_claims={"email_verified": True},
    )
    base.update(over)
    return ProviderIdentity(**base)


async def test_login_reapplies_the_name_from_the_directory(
    sso_provider, db_session,
):
    """The regression this whole feature exists to close.

    Names were written at JIT provisioning and never again, so a rename
    in the directory never reached the product.
    """
    svc = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        _identity(), provider_id=sso_provider.id, linking_policy="strict",
    )

    # Directory renames her.
    await svc.complete_sso_login(
        _identity(first_name="Augusta", last_name="King"),
        provider_id=sso_provider.id, linking_policy="strict",
    )

    row = await user_repo.get_user_by_id(db_session, user.id)
    assert (row.first_name, row.last_name) == ("Augusta", "King")


async def test_login_records_which_fields_it_owns(sso_provider, db_session):
    svc = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        _identity(), provider_id=sso_provider.id, linking_policy="strict",
    )

    row = await user_repo.get_user_by_id(db_session, user.id)
    owned, provider_id = user_repo.idp_ownership(row)
    assert owned == frozenset({"first_name", "last_name"})
    assert provider_id == sso_provider.id


async def test_a_field_the_idp_omits_is_neither_owned_nor_blanked(
    sso_provider, db_session,
):
    """An IdP that releases no surname must leave it alone AND leave it
    editable. Blanking it and locking it is the failure mode that makes
    a naive 'linked means locked' rule unusable."""
    svc = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        _identity(), provider_id=sso_provider.id, linking_policy="strict",
    )
    # Next login: the surname claim has gone.
    await svc.complete_sso_login(
        _identity(last_name=""), provider_id=sso_provider.id,
        linking_policy="strict",
    )

    row = await user_repo.get_user_by_id(db_session, user.id)
    assert row.last_name == "Lovelace", "an omitted claim must not blank the field"
    owned, _ = user_repo.idp_ownership(row)
    assert owned == frozenset({"first_name"})


async def test_display_name_survives_a_directory_rename(
    sso_provider, db_session,
):
    """The escape hatch has to hold across a re-sync, or it is not one."""
    svc = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        _identity(), provider_id=sso_provider.id, linking_policy="strict",
    )
    await user_repo.update_identity(db_session, user.id, display_name="Ada")

    await svc.complete_sso_login(
        _identity(first_name="Augusta"), provider_id=sso_provider.id,
        linking_policy="strict",
    )

    row = await user_repo.get_user_by_id(db_session, user.id)
    assert row.first_name == "Augusta"
    assert row.display_name == "Ada"


async def test_most_recent_provider_wins(db_session):
    """Two IdPs asserting different names must not flap — the one you
    last authenticated with owns the fields, matching how idp_groups
    already resolve."""
    entra = await idp_provider_repo.create_provider(
        db_session, slug="entra-own", display_name="Entra", kind="oidc",
        settings={"issuer": "https://a", "client_id": "c", "client_secret": "s",
                  "redirect_uri": "https://app/cb", "scopes": "openid"},
        claim_mapping={}, linking_policy="allow_verified",
    )
    okta = await idp_provider_repo.create_provider(
        db_session, slug="okta-own", display_name="Okta", kind="oidc",
        settings={"issuer": "https://b", "client_id": "c", "client_secret": "s",
                  "redirect_uri": "https://app/cb", "scopes": "openid"},
        claim_mapping={}, linking_policy="allow_verified",
    )
    await db_session.flush()

    svc = _svc(db_session)
    user, _ = await svc.complete_sso_login(
        _identity(first_name="FromEntra", external_id="e-1"),
        provider_id=entra.id, linking_policy="allow_verified",
    )
    await svc.complete_sso_login(
        _identity(first_name="FromOkta", external_id="o-1"),
        provider_id=okta.id, linking_policy="allow_verified",
    )

    row = await user_repo.get_user_by_id(db_session, user.id)
    assert row.first_name == "FromOkta"
    _owned, provider_id = user_repo.idp_ownership(row)
    assert provider_id == okta.id
