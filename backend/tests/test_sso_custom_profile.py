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
import json
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


def _jwt(claims: dict, *, secret: str = SECRET, ttl: int = 300,
         iat_offset: int = 0, alg: str = "HS256", key=None) -> str:
    now = int(time.time())
    payload = {"iat": now + iat_offset, "exp": now + ttl, **claims}
    return pyjwt.encode(payload, key or secret, algorithm=alg)


# ── Signature + freshness ────────────────────────────────────────────


def test_signed_payload_maps_to_identity():
    provider = CustomProfileProvider(_settings())
    identity = provider.fetch_identity(_jwt({
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


def test_tampered_signature_is_rejected():
    provider = CustomProfileProvider(_settings())
    token = _jwt({"sub": "u1", "email": "a@corp.example"})
    with pytest.raises(CustomProfileError) as exc:
        provider.fetch_identity(token[:-2] + ("aa" if token[-2:] != "aa" else "bb"))
    assert "payload_invalid" in str(exc.value)


def test_payload_signed_with_wrong_secret_is_rejected():
    provider = CustomProfileProvider(_settings())
    with pytest.raises(CustomProfileError):
        provider.fetch_identity(_jwt({"sub": "u1", "email": "a@corp.example"},
                                     secret="w" * 48))


def test_expired_payload_is_rejected():
    provider = CustomProfileProvider(_settings())
    with pytest.raises(CustomProfileError) as exc:
        provider.fetch_identity(_jwt({"sub": "u", "email": "a@corp.example"}, ttl=-10))
    assert str(exc.value) == "payload_expired"


def test_payload_without_exp_is_rejected():
    """``exp`` is required — a portal must not mint an eternal profile."""
    provider = CustomProfileProvider(_settings())
    token = pyjwt.encode(
        {"sub": "u", "email": "a@corp.example", "iat": int(time.time())},
        SECRET, algorithm="HS256",
    )
    with pytest.raises(CustomProfileError):
        provider.fetch_identity(token)


def test_stale_iat_is_rejected_even_when_exp_is_valid():
    """A long-lived ``exp`` must not extend the useful life of a leaked
    payload past ``max_age_seconds``."""
    provider = CustomProfileProvider(_settings(max_age_seconds=60))
    with pytest.raises(CustomProfileError) as exc:
        provider.fetch_identity(
            _jwt({"sub": "u", "email": "a@corp.example"}, ttl=86400, iat_offset=-600)
        )
    assert str(exc.value) == "payload_stale"


def test_max_age_zero_disables_the_freshness_check():
    provider = CustomProfileProvider(_settings(max_age_seconds=0))
    identity = provider.fetch_identity(
        _jwt({"sub": "u", "email": "a@corp.example"}, ttl=86400, iat_offset=-600)
    )
    assert identity.external_id == "u"


def test_issuer_and_audience_are_enforced_when_configured():
    provider = CustomProfileProvider(
        _settings(issuer="https://portal.corp", audience="dataviz")
    )
    ok = provider.fetch_identity(_jwt({
        "sub": "u", "email": "a@corp.example",
        "iss": "https://portal.corp", "aud": "dataviz",
    }))
    assert ok.external_id == "u"

    with pytest.raises(CustomProfileError):
        provider.fetch_identity(_jwt({
            "sub": "u", "email": "a@corp.example",
            "iss": "https://evil.corp", "aud": "dataviz",
        }))


def test_rs256_payload_verifies_against_the_configured_public_key():
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
    identity = provider.fetch_identity(_jwt(
        {"sub": "rs-1", "email": "rs@corp.example"},
        alg="RS256", key=private_pem,
    ))
    assert identity.external_id == "rs-1"


# ── Transport encodings ──────────────────────────────────────────────


def test_base64url_cookie_payload_is_decoded():
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
    identity = CustomProfileProvider(settings).fetch_identity(raw)
    assert (identity.external_id, identity.email) == ("u9", "dee@corp.example")
    assert identity.first_name == "Dee"


def test_url_encoded_cookie_payload_is_decoded():
    settings = _settings(
        source="cookie", source_key="corp_profile",
        payload_format="json", trust_unsigned=True, encoding="url",
    )
    raw = urllib.parse.quote(json.dumps({"sub": "u2", "email": "e@corp.example"}))
    assert CustomProfileProvider(settings).fetch_identity(raw).external_id == "u2"


def test_undecodable_base64_is_rejected():
    settings = _settings(
        payload_format="json", trust_unsigned=True, encoding="base64url",
    )
    with pytest.raises(CustomProfileError):
        CustomProfileProvider(settings).fetch_identity("!!!not-base64!!!")


def test_empty_payload_is_rejected():
    with pytest.raises(CustomProfileError) as exc:
        CustomProfileProvider(_settings()).fetch_identity("   ")
    assert str(exc.value) == "payload_missing"


# ── Nested payloads + required fields ────────────────────────────────


def test_nested_profile_container_is_hoisted():
    """``{"user": {...}}`` maps without the operator writing dotted
    paths."""
    provider = CustomProfileProvider(_settings())
    identity = provider.fetch_identity(_jwt({
        "sub": "u1",
        "user": {"emailAddress": "bob@corp.example",
                 "firstName": "Bob", "lastName": "Ray"},
    }))
    assert identity.email == "bob@corp.example"
    assert (identity.first_name, identity.last_name) == ("Bob", "Ray")


def test_top_level_keys_win_over_nested_ones():
    provider = CustomProfileProvider(_settings())
    identity = provider.fetch_identity(_jwt({
        "sub": "u1", "email": "top@corp.example",
        "profile": {"email": "nested@corp.example"},
    }))
    assert identity.email == "top@corp.example"


def test_missing_email_is_rejected():
    provider = CustomProfileProvider(_settings())
    with pytest.raises(CustomProfileError) as exc:
        provider.fetch_identity(_jwt({"sub": "u1", "firstName": "NoEmail"}))
    assert "resolve email" in str(exc.value)


# ── Config guards (the degraded-trust gates) ─────────────────────────


def test_unsigned_json_requires_explicit_opt_in():
    with pytest.raises(CustomProfileConfigError) as exc:
        validate_settings(_settings(payload_format="json"))
    assert "trust_unsigned" in str(exc.value)


def test_unsigned_json_is_accepted_once_opted_in():
    settings = _settings(payload_format="json", trust_unsigned=True)
    validate_settings(settings)
    identity = CustomProfileProvider(settings).fetch_identity(
        json.dumps({"sub": "u3", "email": "c@corp.example", "fullName": "Cara Lee"})
    )
    assert identity.external_id == "u3"
    assert (identity.first_name, identity.last_name) == ("Cara", "Lee")


def test_provider_refuses_unsigned_payload_even_if_the_builder_was_skipped():
    """Defence in depth: a hand-constructed provider that never went
    through ``validate_settings`` still won't accept unsigned input."""
    provider = CustomProfileProvider(
        _settings(payload_format="json", trust_unsigned=False)
    )
    with pytest.raises(CustomProfileError) as exc:
        provider.fetch_identity(json.dumps({"sub": "u", "email": "a@corp.example"}))
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


@pytest.fixture()
async def registry(db_session):
    """Wire the process registry to the per-test session so the
    slug-routed endpoints resolve real ``idp_providers`` rows."""
    class _Loader:
        @staticmethod
        def _snap(row):
            return ProviderConfigSnapshot(
                id=row.id, slug=row.slug, display_name=row.display_name,
                kind=row.kind, enabled=bool(row.enabled),
                priority=int(row.priority or 100),
                settings=idp_provider_repo.decrypt_settings(row.settings),
                claim_mapping=idp_provider_repo.parse_claim_mapping(row),
                linking_policy=row.linking_policy,
                button_label=row.button_label, button_icon=row.button_icon,
            )

        async def get_by_id(self, provider_id):
            row = await idp_provider_repo.get_provider(db_session, provider_id)
            return self._snap(row) if row is not None else None

        async def get_by_slug(self, slug):
            row = await idp_provider_repo.get_provider_by_slug(db_session, slug)
            return self._snap(row) if row is not None else None

        async def list_enabled(self):
            rows = await idp_provider_repo.list_providers(
                db_session, only_enabled=True,
            )
            return [self._snap(r) for r in rows]

    reg = ProviderRegistry(loader=_Loader(), builders=PROVIDER_BUILDERS,
                           ttl_seconds=0)
    configure_registry(reg)
    yield reg
    await reg.invalidate()


@pytest.fixture()
def sso_events(db_session):
    """Install an ``IdentityService`` on the app that has the SSO repos
    wired (the conftest default is local-password only, so
    ``complete_sso_login`` would bail with ``identity_repo_unavailable``).
    Yields the captured outbox events."""
    from backend.app.main import app

    events: list[tuple[str, dict]] = []

    @asynccontextmanager
    async def _factory():
        yield db_session

    async def _outbox(session, event_type, payload):
        events.append((event_type, payload))

    previous = getattr(app.state, "identity_service", None)
    app.state.identity_service = LocalIdentityService(
        session_factory=_factory,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=lambda s: None,
        outbox_emit=_outbox,
        claims_resolver=None,
    )
    yield events
    app.state.identity_service = previous


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
    assert resp.headers["location"] == "/login?sso_error=1"


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
