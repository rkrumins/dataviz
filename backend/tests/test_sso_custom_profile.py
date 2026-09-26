"""``custom_profile`` IdP — profile handed over via cookie / browser
storage / proxy header.

Three layers:

* **Provider unit tests** — signature verification, freshness, transport
  encodings, and the two config guards that gate the degraded-trust
  modes. No DB, no HTTP.
* **Claim-mapping tests** — the ``DEFAULT_CUSTOM_PROFILE`` candidate
  lists against the field shapes corporate portals actually emit.
* **Route integration** — the server-read (cookie/header) redirect flow
  and the browser-storage POST flow against a live registry, including
  the guard that stops the POST endpoint being used to bypass the
  channel the operator configured.
"""
from __future__ import annotations

import base64
import itertools
import json
import re
import time
import urllib.parse
from contextlib import asynccontextmanager

import jwt as pyjwt
import pytest

from backend.app.db.repositories import (
    idp_provider_repo,
    user_attribute_repo,
    user_identity_repo,
    user_repo,
)
from backend.auth_service.providers.claim_mapper import (
    DEFAULT_CUSTOM_PROFILE,
    apply_claim_mapping,
)
from backend.auth_service.providers.custom_profile import (
    CustomProfileConfigError,
    _MemoryJtiCache,
    CustomProfileError,
    CustomProfileProvider,
    CustomProfileSettings,
    build_custom_profile_provider,
    validate_settings,
)
from backend.auth_service.providers.registry import (
    ProviderConfigSnapshot,
    ProviderRegistry,
    configure_registry,
)
from backend.auth_service.providers import PROVIDER_BUILDERS
from backend.auth_service.service import LocalIdentityService

SECRET = "s" * 48


def _settings(**over) -> CustomProfileSettings:
    base = dict(
        provider_id="idp_test",
        provider_slug="corp-portal",
        source="local_storage",
        source_key="corp.user",
        shared_secret=SECRET,
    )
    base.update(over)
    return CustomProfileSettings(**base)


_JTI_SEQ = itertools.count()


def _jwt(claims: dict, *, secret: str = SECRET, ttl: int = 300,
         iat_offset: int = 0, alg: str = "HS256", key=None) -> str:
    """A signed payload.

    ``jti`` is minted per call and unique, because it is now required and
    single-use: a portal must issue a fresh payload per sign-in. Pass
    ``jti`` explicitly in *claims* to pin it (replay tests) or to omit it
    (the missing-claim test).
    """
    now = int(time.time())
    payload = {
        "iat": now + iat_offset,
        "exp": now + ttl,
        "jti": f"jti-{next(_JTI_SEQ)}",
        **claims,
    }
    return pyjwt.encode(payload, key or secret, algorithm=alg)


# ── Signature + freshness ────────────────────────────────────────────


async def test_signed_payload_maps_to_identity():
    provider = CustomProfileProvider(_settings())
    identity = await provider.fetch_identity(_jwt({
        "sub": "S-1-5-21-1001",
        "emailAddress": "Alice.Doe@CORP.example",
        "firstName": "Alice",
        "lastName": "Doe",
        "groups": ["Eng-All", "DataViz-Admins"],
    }))

    assert identity.provider == "custom_profile"
    assert identity.external_id == "S-1-5-21-1001"
    # Emails are normalised to lowercase by the shared mapper.
    assert identity.email == "alice.doe@corp.example"
    assert (identity.first_name, identity.last_name) == ("Alice", "Doe")
    assert identity.groups == ("Eng-All", "DataViz-Admins")


async def test_tampered_signature_is_rejected():
    provider = CustomProfileProvider(_settings())
    token = _jwt({"sub": "u1", "email": "a@corp.example"})
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(token[:-2] + ("aa" if token[-2:] != "aa" else "bb"))
    assert "payload_invalid" in str(exc.value)


async def test_payload_signed_with_wrong_secret_is_rejected():
    provider = CustomProfileProvider(_settings())
    with pytest.raises(CustomProfileError):
        await provider.fetch_identity(_jwt({"sub": "u1", "email": "a@corp.example"},
                                     secret="w" * 48))


async def test_expired_payload_is_rejected():
    provider = CustomProfileProvider(_settings())
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(_jwt({"sub": "u", "email": "a@corp.example"}, ttl=-10))
    assert str(exc.value) == "payload_expired"


async def test_payload_without_exp_is_rejected():
    """``exp`` is required — a portal must not mint an eternal profile."""
    provider = CustomProfileProvider(_settings())
    token = pyjwt.encode(
        {"sub": "u", "email": "a@corp.example", "iat": int(time.time())},
        SECRET, algorithm="HS256",
    )
    with pytest.raises(CustomProfileError):
        await provider.fetch_identity(token)


async def test_stale_iat_is_rejected_even_when_exp_is_valid():
    """A long-lived ``exp`` must not extend the useful life of a leaked
    payload past ``max_age_seconds``."""
    provider = CustomProfileProvider(_settings(max_age_seconds=60))
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(
            _jwt({"sub": "u", "email": "a@corp.example"}, ttl=86400, iat_offset=-600)
        )
    assert str(exc.value) == "payload_stale"


async def test_max_age_zero_disables_the_freshness_check():
    provider = CustomProfileProvider(_settings(max_age_seconds=0))
    identity = await provider.fetch_identity(
        _jwt({"sub": "u", "email": "a@corp.example"}, ttl=86400, iat_offset=-600)
    )
    assert identity.external_id == "u"


async def test_issuer_and_audience_are_enforced_when_configured():
    provider = CustomProfileProvider(
        _settings(issuer="https://portal.corp", audience="dataviz")
    )
    ok = await provider.fetch_identity(_jwt({
        "sub": "u", "email": "a@corp.example",
        "iss": "https://portal.corp", "aud": "dataviz",
    }))
    assert ok.external_id == "u"

    with pytest.raises(CustomProfileError):
        await provider.fetch_identity(_jwt({
            "sub": "u", "email": "a@corp.example",
            "iss": "https://evil.corp", "aud": "dataviz",
        }))


async def test_rs256_payload_verifies_against_the_configured_public_key():
    crypto = pytest.importorskip("cryptography")  # noqa: F841
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    provider = CustomProfileProvider(
        _settings(signing_alg="RS256", shared_secret="", public_key=public_pem)
    )
    identity = await provider.fetch_identity(_jwt(
        {"sub": "rs-1", "email": "rs@corp.example"},
        alg="RS256", key=private_pem,
    ))
    assert identity.external_id == "rs-1"


# ── Transport encodings ──────────────────────────────────────────────


async def test_base64url_cookie_payload_is_decoded():
    """Cookies can't carry raw JSON, so portals base64url it — including
    with the padding stripped."""
    settings = _settings(
        source="cookie", source_key="corp_profile",
        payload_format="json", trust_unsigned=True, encoding="base64url",
    )
    raw = base64.urlsafe_b64encode(
        json.dumps({"userId": "u9", "mail": "dee@corp.example",
                    "givenName": "Dee"}).encode()
    ).decode().rstrip("=")
    identity = await CustomProfileProvider(settings).fetch_identity(raw)
    assert (identity.external_id, identity.email) == ("u9", "dee@corp.example")
    assert identity.first_name == "Dee"


async def test_url_encoded_cookie_payload_is_decoded():
    settings = _settings(
        source="cookie", source_key="corp_profile",
        payload_format="json", trust_unsigned=True, encoding="url",
    )
    raw = urllib.parse.quote(json.dumps({"sub": "u2", "email": "e@corp.example"}))
    identity = await CustomProfileProvider(settings).fetch_identity(raw)
    assert identity.external_id == "u2"


async def test_undecodable_base64_is_rejected():
    settings = _settings(
        payload_format="json", trust_unsigned=True, encoding="base64url",
    )
    with pytest.raises(CustomProfileError):
        await CustomProfileProvider(settings).fetch_identity("!!!not-base64!!!")


async def test_empty_payload_is_rejected():
    with pytest.raises(CustomProfileError) as exc:
        await CustomProfileProvider(_settings()).fetch_identity("   ")
    assert str(exc.value) == "payload_missing"


# ── Nested payloads + required fields ────────────────────────────────


async def test_nested_profile_container_is_hoisted():
    """``{"user": {...}}`` maps without the operator writing dotted
    paths."""
    provider = CustomProfileProvider(_settings())
    identity = await provider.fetch_identity(_jwt({
        "sub": "u1",
        "user": {"emailAddress": "bob@corp.example",
                 "firstName": "Bob", "lastName": "Ray"},
    }))
    assert identity.email == "bob@corp.example"
    assert (identity.first_name, identity.last_name) == ("Bob", "Ray")


async def test_top_level_keys_win_over_nested_ones():
    provider = CustomProfileProvider(_settings())
    identity = await provider.fetch_identity(_jwt({
        "sub": "u1", "email": "top@corp.example",
        "profile": {"email": "nested@corp.example"},
    }))
    assert identity.email == "top@corp.example"


async def test_any_container_name_is_hoisted_and_empties_never_shadow():
    """The hoist is generic over container names (shared with the
    backchannel kind), and a vestigial top-level ``groups: []`` no
    longer shadows the populated list one level down."""
    provider = CustomProfileProvider(_settings())
    identity = await provider.fetch_identity(_jwt({
        "sub": "u1",
        "groups": [],
        "whateverThePortalCallsIt": {
            "email": "bob@corp.example",
            "groups": ["my-super-cool-group"],
        },
    }))
    assert identity.email == "bob@corp.example"
    assert identity.groups == ("my-super-cool-group",)


async def test_missing_email_is_rejected():
    provider = CustomProfileProvider(_settings())
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(_jwt({"sub": "u1", "firstName": "NoEmail"}))
    assert "resolve email" in str(exc.value)


# ── Config guards (the degraded-trust gates) ─────────────────────────


def test_unsigned_json_requires_explicit_opt_in():
    with pytest.raises(CustomProfileConfigError) as exc:
        validate_settings(_settings(payload_format="json"))
    assert "trust_unsigned" in str(exc.value)


async def test_unsigned_json_is_accepted_once_opted_in():
    settings = _settings(payload_format="json", trust_unsigned=True)
    validate_settings(settings)
    identity = await CustomProfileProvider(settings).fetch_identity(
        json.dumps({"sub": "u3", "email": "c@corp.example", "fullName": "Cara Lee"})
    )
    assert identity.external_id == "u3"
    assert (identity.first_name, identity.last_name) == ("Cara", "Lee")


async def test_provider_refuses_unsigned_payload_even_if_the_builder_was_skipped():
    """Defence in depth: a hand-constructed provider that never went
    through ``validate_settings`` still won't accept unsigned input."""
    provider = CustomProfileProvider(
        _settings(payload_format="json", trust_unsigned=False)
    )
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(json.dumps({"sub": "u", "email": "a@corp.example"}))
    assert str(exc.value) == "unsigned_not_permitted"


def test_header_source_requires_trusted_proxy_acknowledgement():
    with pytest.raises(CustomProfileConfigError) as exc:
        validate_settings(_settings(source="header", source_key="SM_USER"))
    assert "trusted_proxy_acknowledged" in str(exc.value)

    validate_settings(_settings(
        source="header", source_key="SM_USER", trusted_proxy_acknowledged=True,
    ))


@pytest.mark.parametrize("over, fragment", [
    ({"source": "telepathy"}, "source must be one of"),
    ({"source_key": ""}, "source_key is required"),
    ({"encoding": "rot13"}, "encoding must be one of"),
    ({"payload_format": "xml"}, "payload_format must be one of"),
    ({"signing_alg": "none"}, "signing_alg must be one of"),
    ({"signing_alg": "RS256", "shared_secret": ""}, "requires public_key"),
    ({"shared_secret": ""}, "requires shared_secret"),
    ({"max_age_seconds": -1}, "max_age_seconds must be >= 0"),
])
def test_misconfigured_rows_fail_loudly(over, fragment):
    with pytest.raises(CustomProfileConfigError) as exc:
        validate_settings(_settings(**over))
    assert fragment in str(exc.value)


def test_builder_validates_before_returning():
    snap = ProviderConfigSnapshot(
        id="idp_x", slug="broken", display_name="Broken",
        kind="custom_profile", enabled=True, priority=100,
        settings={"source": "header", "source_key": "SM_USER",
                  "shared_secret": SECRET},
        claim_mapping={}, linking_policy="strict",
        button_label=None, button_icon=None,
    )
    with pytest.raises(CustomProfileConfigError):
        build_custom_profile_provider(snap)


def test_builder_reads_every_setting_off_the_snapshot():
    snap = ProviderConfigSnapshot(
        id="idp_y", slug="portal", display_name="Portal",
        kind="custom_profile", enabled=True, priority=50,
        settings={
            "source": "cookie", "source_key": "corp_profile",
            "encoding": "base64url", "payload_format": "json",
            "trust_unsigned": "true", "max_age_seconds": "120",
        },
        claim_mapping={"email": ["mail"]}, linking_policy="allow_verified",
        button_label=None, button_icon=None,
    )
    provider = build_custom_profile_provider(snap)
    s = provider.settings
    assert s.source == "cookie" and s.source_key == "corp_profile"
    assert s.encoding == "base64url" and s.payload_format == "json"
    # String-ish values from the JSON settings blob are coerced.
    assert s.trust_unsigned is True and s.max_age_seconds == 120
    assert s.linking_policy == "allow_verified"
    assert provider.reads_from_browser is False


# ── Claim mapping defaults ───────────────────────────────────────────


@pytest.mark.parametrize("claims, expected", [
    ({"sub": "a", "email": "x@c.io"}, ("a", "x@c.io")),
    ({"userId": "b", "emailAddress": "x@c.io"}, ("b", "x@c.io")),
    ({"user_id": "c", "email_address": "x@c.io"}, ("c", "x@c.io")),
    ({"employeeId": "d", "mail": "x@c.io"}, ("d", "x@c.io")),
    ({"uid": "e", "upn": "x@c.io"}, ("e", "x@c.io")),
])
def test_default_mapping_covers_common_portal_casings(claims, expected):
    identity = apply_claim_mapping(
        claims, kind="custom_profile", provider_slug="p",
    )
    assert (identity.external_id, identity.email) == expected


def test_email_is_the_last_resort_external_id():
    """A portal with no stable subject id still gets a durable join key."""
    identity = apply_claim_mapping(
        {"email": "only@corp.example"}, kind="custom_profile", provider_slug="p",
    )
    assert identity.external_id == "only@corp.example"


def test_full_name_only_payload_is_split():
    identity = apply_claim_mapping(
        {"sub": "u", "email": "x@c.io", "fullName": "Ada Byron Lovelace"},
        kind="custom_profile", provider_slug="p",
    )
    assert identity.first_name == "Ada"
    assert identity.last_name == "Byron Lovelace"


def test_extras_are_mapped_from_operator_config():
    identity = apply_claim_mapping(
        {"sub": "u", "email": "x@c.io", "dept": "Engineering",
         "staffNumber": "12345"},
        kind="custom_profile", provider_slug="p",
        override={"extras": {"department": ["dept"], "staff_id": ["staffNumber"]}},
    )
    assert identity.attributes == {"department": "Engineering", "staff_id": "12345"}


def test_default_mapping_shape_is_complete():
    """Every field the mapper reads must have a default candidate list,
    or a fresh provider silently drops it."""
    for key in ("external_id", "email", "email_verified", "first_name",
                "last_name", "display_name", "groups", "auth_time"):
        assert DEFAULT_CUSTOM_PROFILE[key], f"{key} has no default candidates"


# ── Route integration ────────────────────────────────────────────────


async def _make_provider(db_session, **settings_over):
    settings = {
        "source": "local_storage", "source_key": "corp.user",
        "payload_format": "jwt", "signing_alg": "HS256",
        "shared_secret": SECRET,
    }
    settings.update(settings_over)
    row = await idp_provider_repo.create_provider(
        db_session,
        slug=settings.pop("_slug", "corp-portal"),
        display_name="Corporate Portal",
        kind="custom_profile",
        settings=settings,
        claim_mapping={"extras": {"department": ["department"]}},
        linking_policy="strict",
    )
    await db_session.commit()
    return row


@pytest.mark.asyncio
async def test_browser_profile_post_provisions_and_sets_cookies(
    test_client, db_session, registry, sso_events,
):
    await _make_provider(db_session)
    resp = await test_client.post(
        "/api/v1/auth/corp-portal/browser-profile",
        json={"payload": _jwt({
            "sub": "S-1-1001", "emailAddress": "jit@corp.example",
            "fullName": "Jit User", "department": "Platform",
        })},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["user"]["email"] == "jit@corp.example"
    assert "nx_access" in resp.cookies

    identity = await user_identity_repo.get_by_subject(
        db_session, provider_id=(await idp_provider_repo.get_provider_by_slug(
            db_session, "corp-portal")).id,
        external_id="S-1-1001",
    )
    assert identity is not None
    attrs = await user_attribute_repo.list_for_user(db_session, identity.user_id)
    assert {a.key: a.value for a in attrs}["department"] == "Platform"


@pytest.mark.asyncio
async def test_browser_profile_post_rejects_bad_signature(
    test_client, db_session, registry,
):
    await _make_provider(db_session)
    resp = await test_client.post(
        "/api/v1/auth/corp-portal/browser-profile",
        json={"payload": _jwt({"sub": "u", "email": "a@corp.example"},
                              secret="w" * 48)},
    )
    assert resp.status_code == 401
    # The precise reason is logged, never returned.
    assert resp.json()["detail"] == {"error": "profile_rejected"}


@pytest.mark.asyncio
async def test_browser_profile_post_is_refused_for_a_cookie_sourced_row(
    test_client, db_session, registry,
):
    """The POST endpoint must not become a way to hand us a payload for
    a provider the operator configured to read server-side."""
    await _make_provider(db_session, source="cookie", source_key="corp_profile")
    resp = await test_client.post(
        "/api/v1/auth/corp-portal/browser-profile",
        json={"payload": _jwt({"sub": "u", "email": "a@corp.example"})},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_cookie_source_completes_through_the_login_redirect(
    test_client, db_session, registry, sso_events,
):
    await _make_provider(db_session, source="cookie", source_key="corp_profile")
    resp = await test_client.get(
        "/api/v1/auth/corp-portal/login?next=/dashboard",
        cookies={"corp_profile": _jwt({
            "sub": "S-1-2002", "emailAddress": "cookie@corp.example",
            "firstName": "Cook", "lastName": "Ie",
        })},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/dashboard"
    assert "nx_access" in resp.cookies


@pytest.mark.asyncio
async def test_cookie_source_without_a_cookie_bounces_to_the_error_page(
    test_client, db_session, registry,
):
    await _make_provider(db_session, source="cookie", source_key="corp_profile")
    resp = await test_client.get(
        "/api/v1/auth/corp-portal/login", follow_redirects=False,
    )
    assert resp.status_code == 302
    location = resp.headers["location"]
    # Generic to the user, but carrying a ref they can quote to an admin who
    # can look the real reason up in the audit log.
    assert location.startswith("/login?")
    assert "sso_error=1" in location
    assert re.search(r"ref=[0-9a-f]{8}", location)


@pytest.mark.asyncio
async def test_storage_source_bounces_to_the_portal_login_page(
    test_client, db_session, registry,
):
    """The 24h re-auth bounce lands on GET /login — for a storage-backed
    row that must forward to the page that can read the key."""
    await _make_provider(db_session)
    resp = await test_client.get(
        "/api/v1/auth/corp-portal/login?next=/canvas", follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/portal-login?next=/canvas&slug=corp-portal"


@pytest.mark.asyncio
async def test_provider_catalog_exposes_the_storage_key_but_no_secret(
    test_client, db_session, registry,
):
    await _make_provider(db_session)
    resp = await test_client.get("/api/v1/auth/providers")
    assert resp.status_code == 200
    row = next(p for p in resp.json() if p["slug"] == "corp-portal")
    assert row["config"] == {"source": "local_storage", "sourceKey": "corp.user"}
    assert SECRET not in resp.text


@pytest.mark.asyncio
async def test_catalog_hides_the_source_key_for_server_read_sources(
    test_client, db_session, registry,
):
    await _make_provider(db_session, source="cookie", source_key="corp_profile")
    resp = await test_client.get("/api/v1/auth/providers")
    row = next(p for p in resp.json() if p["slug"] == "corp-portal")
    assert row["config"] == {"source": "cookie"}


@pytest.mark.asyncio
async def test_admin_redacts_the_shared_secret(test_client, db_session, registry):
    row = await _make_provider(db_session)
    resp = await test_client.get("/api/v1/admin/idp-providers")
    assert resp.status_code == 200
    dto = next(p for p in resp.json() if p["id"] == row.id)
    assert dto["settings"]["shared_secret"] == "********"
    assert SECRET not in resp.text


@pytest.mark.asyncio
async def test_admin_serves_the_default_mapping_for_the_new_kind(test_client):
    resp = await test_client.get(
        "/api/v1/admin/idp-providers/defaults/custom_profile",
    )
    assert resp.status_code == 200
    assert resp.json()["first_name"] == DEFAULT_CUSTOM_PROFILE["first_name"]


# ── Degraded-trust auditing ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_unsigned_login_emits_its_own_audit_event(
    test_client, db_session, registry, sso_events,
):
    await _make_provider(db_session, payload_format="json", trust_unsigned=True)
    resp = await test_client.post(
        "/api/v1/auth/corp-portal/browser-profile",
        json={"payload": json.dumps({
            "sub": "S-1-3003", "email": "unsigned@corp.example",
        })},
    )
    assert resp.status_code == 200, resp.text

    types = [e[0] for e in sso_events]
    assert "user.sso_unsigned_accepted" in types
    assert "user.logged_in" in types


@pytest.mark.asyncio
async def test_signed_login_emits_no_degraded_trust_event(
    test_client, db_session, registry, sso_events,
):
    await _make_provider(db_session)
    resp = await test_client.post(
        "/api/v1/auth/corp-portal/browser-profile",
        json={"payload": _jwt({"sub": "S-1-4004", "email": "signed@corp.example"})},
    )
    assert resp.status_code == 200, resp.text

    types = [e[0] for e in sso_events]
    assert "user.logged_in" in types
    assert "user.sso_unsigned_accepted" not in types
    assert "user.sso_header_accepted" not in types


@pytest.mark.asyncio
async def test_header_login_emits_its_own_audit_event(
    test_client, db_session, registry, sso_events,
):
    await _make_provider(
        db_session, source="header", source_key="X-Corp-Profile",
        trusted_proxy_acknowledged=True,
    )
    resp = await test_client.get(
        "/api/v1/auth/corp-portal/login?next=/dashboard",
        headers={"X-Corp-Profile": _jwt({
            "sub": "S-1-5005", "email": "proxied@corp.example",
        })},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/dashboard"
    assert "user.sso_header_accepted" in [e[0] for e in sso_events]


# ── Replay, freshness, and the claims that make them possible ────────
#
# A signature proves the PORTAL minted this payload. It says nothing
# about who is presenting it. Before this, a copied payload — lifted
# from a shared machine, a proxy log, a browser extension reading
# localStorage — was a working credential for its whole lifetime, and it
# produced a legitimately minted session of the copier's own: nothing to
# revoke, and no signal it had happened.

async def test_a_payload_works_exactly_once():
    """The headline property. Same bytes, presented twice."""
    provider = CustomProfileProvider(_settings())
    raw = _jwt({"sub": "u1", "email": "ana@corp.example"})

    first = await provider.fetch_identity(raw)
    assert first.external_id == "u1"

    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(raw)
    assert str(exc.value) == "payload_replayed"


async def test_a_replay_is_refused_across_provider_rebuilds():
    """``ProviderRegistry`` rebuilds the provider every 60s. A cache that
    lives on the provider forgets every id on each rebuild, well inside
    the payload's own TTL — which is precisely how the SAML replay cache
    managed to look real and enforce nothing."""
    shared = _MemoryJtiCache()
    raw = _jwt({"sub": "u1", "email": "ana@corp.example"})

    assert await CustomProfileProvider(
        _settings(), replay_cache=shared,
    ).fetch_identity(raw)

    with pytest.raises(CustomProfileError) as exc:
        await CustomProfileProvider(
            _settings(), replay_cache=shared,
        ).fetch_identity(raw)
    assert str(exc.value) == "payload_replayed"


async def test_distinct_payloads_are_both_accepted():
    """Guards the guard: if every payload were refused, the replay tests
    above would pass for the wrong reason."""
    provider = CustomProfileProvider(_settings())
    assert await provider.fetch_identity(_jwt({"sub": "u1", "email": "a@c.example"}))
    assert await provider.fetch_identity(_jwt({"sub": "u2", "email": "b@c.example"}))


async def test_a_payload_without_jti_is_refused():
    """Single-use is not optional: without an id there is nothing to
    burn, so the payload would be replayable for its whole lifetime."""
    provider = CustomProfileProvider(_settings())
    raw = _jwt({"sub": "u1", "email": "ana@corp.example", "jti": None})
    # pyjwt drops a None claim, so this really is a payload with no jti.
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(raw)
    assert "jti" in str(exc.value)


async def test_a_payload_without_iat_is_refused():
    """THE BYPASS. ``require`` listed only ``exp`` and the age check read
    ``if issued is not None``, so a payload with a far-future ``exp`` and
    no ``iat`` skipped freshness entirely — the opposite of what
    SSO.md:622 promises."""
    now = int(time.time())
    raw = pyjwt.encode(
        {"exp": now + 31_536_000, "jti": "no-iat-1",
         "sub": "u1", "email": "ana@corp.example"},
        SECRET, algorithm="HS256",
    )
    with pytest.raises(CustomProfileError) as exc:
        await CustomProfileProvider(_settings()).fetch_identity(raw)
    assert "iat" in str(exc.value)


async def test_a_future_dated_payload_is_refused():
    """Beyond freshness: ``iat`` feeds the 24h SSO re-auth ceiling by
    default (claim_mapper's auth_time candidates end in "iat"), so a
    future-dated payload yields a negative session age and never trips
    that ceiling."""
    provider = CustomProfileProvider(_settings())
    raw = _jwt({"sub": "u1", "email": "ana@corp.example"}, iat_offset=3600)
    with pytest.raises(CustomProfileError) as exc:
        await provider.fetch_identity(raw)
    assert str(exc.value) == "payload_future_iat"


async def test_small_clock_skew_is_tolerated():
    """A freshness bound must not become a support ticket about NTP.

    pyjwt applies ZERO tolerance by default, so before the explicit
    leeway a portal one second ahead of us failed every single login.
    """
    provider = CustomProfileProvider(_settings())
    raw = _jwt({"sub": "u1", "email": "ana@corp.example"}, iat_offset=30)
    assert await provider.fetch_identity(raw)


# ── Production refuses a signed provider with no shared store ────────
#
# Same stance, and the same reason, as the SAML replay cache: the
# in-process fallback silently LOOKS like replay protection. Four
# workers per container across N replicas each hold their own dict, and
# the registry rebuilds the provider every 60s — so a copied payload
# only has to land on a worker that has not seen it, or on the same
# worker a minute later.

def _snapshot(**settings):
    base = {
        "source": "cookie", "source_key": "corp_profile",
        "shared_secret": SECRET,
    }
    base.update(settings)
    return ProviderConfigSnapshot(
        id="idp_x", slug="corp-portal", display_name="Corp",
        kind="custom_profile", enabled=True, priority=1,
        settings=base, claim_mapping={}, linking_policy="strict",
        button_label=None, button_icon=None,
    )


def test_production_refuses_a_signed_provider_without_a_shared_cache():
    from backend.app.main import profile_builder_with_replay_cache

    def _base(snap, replay_cache=None):  # pragma: no cover - must not run
        raise AssertionError("the guard should have refused first")

    build = profile_builder_with_replay_cache(_base, None, True)
    with pytest.raises(RuntimeError) as err:
        build(_snapshot())
    assert "corp-portal" in str(err.value)


def test_production_allows_an_unsigned_provider_without_a_cache():
    """Unsigned rows have no ``jti`` to burn, and they are already an
    explicit operator-acknowledged escape hatch. Refusing them HERE
    would be refusing them on a technicality rather than on merit."""
    from backend.app.main import profile_builder_with_replay_cache

    build = profile_builder_with_replay_cache(
        lambda s, replay_cache=None: "provider", None, True,
    )
    assert build(_snapshot(payload_format="json", trust_unsigned=True)) == "provider"


def test_a_shared_cache_is_handed_to_the_provider():
    from backend.app.main import profile_builder_with_replay_cache

    seen = {}

    def _base(snap, replay_cache=None):
        seen["cache"] = replay_cache
        return "provider"

    cache = object()
    for is_prod in (True, False):
        seen.clear()
        assert profile_builder_with_replay_cache(_base, cache, is_prod)(
            _snapshot(),
        ) == "provider"
        assert seen["cache"] is cache


def test_a_dev_deployment_without_a_shared_cache_still_builds():
    from backend.app.main import profile_builder_with_replay_cache

    build = profile_builder_with_replay_cache(
        lambda s, replay_cache=None: "provider", None, False,
    )
    assert build(_snapshot()) == "provider"
