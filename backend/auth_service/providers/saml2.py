"""
SAML 2.0 identity provider — Service Provider role, HTTP-Redirect /
HTTP-POST bindings.

Implements the ``IdentityProvider`` seam for any SAML 2.0 IdP (ADFS,
Entra ID SAML, Okta, OneLogin, PingFederate, …) by delegating the
protocol to ``python3-saml`` (OneLogin SAML toolkit). The provider
owns *the protocol*; the routes in ``api/router.py`` own the browser
redirects and cookie handling, and ``service.py`` owns find-or-provision
+ linking + group reconciliation. That split mirrors the OIDC provider
exactly.

Security properties enforced here (in addition to whatever the library
enforces in strict mode):

* Assertion signature, ``Conditions/NotBefore``+``NotOnOrAfter``,
  ``AudienceRestriction``, ``SubjectConfirmation/Recipient`` (via
  ``OneLogin_Saml2_Auth`` strict mode + ``wantAssertionsSigned``).
* Assertion-ID **replay cache** (Redis: ``saml:asid:<id>``) with TTL =
  remaining lifetime so a captured response can't be replayed within
  its own validity window.
* XML Signature Wrapping defended by the library's strict parsing.

Crypto is delegated to ``xmlsec1`` (system) via ``python3-saml`` —
nothing here hand-rolls signature or canonicalisation.
"""
from __future__ import annotations

import logging
import os
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from dataclasses import field

from .base import ProviderCredentials, ProviderIdentity
from .claim_mapper import apply_claim_mapping, ClaimMappingError
from .registry import ProviderConfigSnapshot

from .outbound import BlockedOutboundRequest, fetch_metadata

logger = logging.getLogger(__name__)


class SamlError(Exception):
    """Any failure in the SAML handshake (config, signature, conditions,
    replay). Routes map this to a generic auth failure — details are
    logged, never surfaced to the browser."""


@dataclass(frozen=True)
class SamlSettings:
    """Static configuration for the SAML SP.

    Phase 3: built per ``idp_providers`` row by
    :func:`build_saml_provider`. Operators stash the same fields in
    the provider's encrypted ``settings`` JSON via the admin UI; the
    env-only loader stays as a one-shot seeder for legacy deployments.

    ``enabled`` is derived from "settings are minimally populated"
    rather than a manual flag, matching the OIDC settings shape.
    """
    sp_entity_id: str = ""
    sp_acs_url: str = ""
    sp_slo_url: str = ""
    idp_entity_id: str = ""
    idp_sso_url: str = ""
    idp_slo_url: str = ""
    idp_x509_cert: str = ""    # PEM body without headers, or full PEM
    sp_x509_cert: str = ""     # required for signing/encryption (optional)
    sp_private_key: str = ""
    name_id_format: str = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    default_next: str = "/"
    provider_id: str = "test-saml"
    provider_slug: str = "test-saml"
    claim_mapping_override: dict = field(default_factory=dict)
    linking_policy: str = "strict"

    @property
    def enabled(self) -> bool:
        return bool(
            self.sp_entity_id and self.sp_acs_url
            and self.idp_entity_id and self.idp_sso_url
            and self.idp_x509_cert
        )


def _env_or_file(key: str) -> str:
    """Resolve a config value from env directly OR from a path env.

    For x509 cert / private key material, operators typically mount the
    file and point ``SAML_SP_PRIVATE_KEY_FILE`` at it. Both forms are
    supported; whichever is set wins.
    """
    inline = os.getenv(key, "").strip()
    if inline:
        return inline
    path_key = f"{key}_FILE"
    path = os.getenv(path_key, "").strip()
    if path and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        except OSError as exc:
            logger.warning("SAML: failed to read %s=%s: %s", path_key, path, exc)
    return ""


def load_env_saml_settings() -> SamlSettings | None:
    """Read the legacy ``SAML_*`` env vars into a synthetic settings
    object for the boot-time seeder in ``app/main.py``. Returns
    ``None`` when nothing is configured."""
    if os.getenv("SAML_ENABLED", "false").lower() != "true":
        return None
    return SamlSettings(
        sp_entity_id=os.getenv("SAML_SP_ENTITY_ID", ""),
        sp_acs_url=os.getenv("SAML_SP_ACS_URL", ""),
        sp_slo_url=os.getenv("SAML_SP_SLO_URL", ""),
        idp_entity_id=os.getenv("SAML_IDP_ENTITY_ID", ""),
        idp_sso_url=os.getenv("SAML_IDP_SSO_URL", ""),
        idp_slo_url=os.getenv("SAML_IDP_SLO_URL", ""),
        idp_x509_cert=_env_or_file("SAML_IDP_X509_CERT"),
        sp_x509_cert=_env_or_file("SAML_SP_X509_CERT"),
        sp_private_key=_env_or_file("SAML_SP_PRIVATE_KEY"),
        name_id_format=os.getenv(
            "SAML_NAME_ID_FORMAT",
            "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        ),
        default_next=os.getenv("SAML_DEFAULT_NEXT", "/"),
        provider_id="env-bootstrap",
        provider_slug="default-saml2",
    )


load_saml_settings = load_env_saml_settings  # Phase 2 compat alias


def settings_from_snapshot(snap: ProviderConfigSnapshot) -> SamlSettings:
    """Build :class:`SamlSettings` from a registry snapshot."""
    s = snap.settings or {}
    return SamlSettings(
        sp_entity_id=str(s.get("sp_entity_id", "")),
        sp_acs_url=str(s.get("sp_acs_url", "")),
        sp_slo_url=str(s.get("sp_slo_url", "")),
        idp_entity_id=str(s.get("idp_entity_id", "")),
        idp_sso_url=str(s.get("idp_sso_url", "")),
        idp_slo_url=str(s.get("idp_slo_url", "")),
        idp_x509_cert=str(s.get("idp_x509_cert", "")),
        sp_x509_cert=str(s.get("sp_x509_cert", "")),
        sp_private_key=str(s.get("sp_private_key", "")),
        name_id_format=str(
            s.get("name_id_format",
                  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress")
        ),
        default_next=str(s.get("default_next", "/")),
        provider_id=snap.id,
        provider_slug=snap.slug,
        claim_mapping_override=snap.claim_mapping or {},
        linking_policy=snap.linking_policy,
    )


def _normalise_cert(pem_or_body: str) -> str:
    """Strip BEGIN/END headers if present; python3-saml expects body only."""
    text = pem_or_body.strip()
    if "-----BEGIN" in text:
        lines = [
            ln for ln in text.splitlines()
            if ln.strip() and not ln.startswith("-----")
        ]
        return "".join(lines)
    return text


class SamlProvider:
    """SAML 2.0 provider. One instance per process, registered as ``saml2``.

    The browser-redirect dance is driven by routes in ``api/router.py``
    (``/auth/saml/{metadata,login,acs,sls}``). This class is stateless
    apart from cached settings + the replay-cache hook injected at
    construction; nothing here touches HTTP request/response state.
    """

    name = "saml2"

    def __init__(
        self,
        settings: SamlSettings,
        *,
        replay_cache=None,
    ):
        self._s = settings
        # ``replay_cache`` is a callable
        #   (assertion_id: str, expires_at_epoch: int) -> bool
        # that returns True if this is the first time we've seen
        # ``assertion_id`` (and records it for ``expires_at - now``
        # seconds), or False if it's already in the cache. Wired to the
        # Redis revocation backend at app startup; falls back to a
        # process-local dict in tests.
        self._replay_cache = replay_cache or _MemoryReplayCache()

    @property
    def settings(self) -> SamlSettings:
        return self._s

    @property
    def slug(self) -> str:
        return self._s.provider_slug

    @property
    def provider_id(self) -> str:
        return self._s.provider_id

    @property
    def enabled(self) -> bool:
        return self._s.enabled

    # ── IdentityProvider protocol ────────────────────────────────────
    #
    # SAML is a redirect/POST-binding authenticator — the actual flow
    # is driven by the routes. This stub satisfies the Protocol so the
    # registry/typing stays uniform.
    async def authenticate(
        self, credentials: ProviderCredentials, *, get_user_by_email,
    ) -> Optional[ProviderIdentity]:
        return None

    # ── Library glue ─────────────────────────────────────────────────

    def _settings_dict(self, *, want_messages_signed: bool = False) -> dict:
        """Build the OneLogin settings dict from our static config.

        ``want_messages_signed`` is set only on the SLO path — see
        ``process_slo`` for why it cannot be on globally.
        """
        s = self._s
        d: dict = {
            "strict": True,
            "debug": False,
            "sp": {
                "entityId": s.sp_entity_id,
                "assertionConsumerService": {
                    "url": s.sp_acs_url,
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
                },
                "singleLogoutService": {
                    "url": s.sp_slo_url,
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                } if s.sp_slo_url else {},
                "NameIDFormat": s.name_id_format,
                "x509cert": _normalise_cert(s.sp_x509_cert),
                "privateKey": s.sp_private_key,
            },
            "idp": {
                "entityId": s.idp_entity_id,
                "singleSignOnService": {
                    "url": s.idp_sso_url,
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                },
                "singleLogoutService": {
                    "url": s.idp_slo_url,
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                } if s.idp_slo_url else {},
                "x509cert": _normalise_cert(s.idp_x509_cert),
            },
            "security": {
                # Strict signature + replay defences.
                "wantAssertionsSigned": True,
                # ID-style IdPs sign assertions only, so requiring a signed
            # Response would break login against them. SLO passes True
            # because a LogoutRequest has no assertion to carry the
            # signature instead.
            "wantMessagesSigned": want_messages_signed,
                "wantAssertionsEncrypted": False,
                "wantNameIdEncrypted": False,
                "requestedAuthnContext": False,
                "rejectDeprecatedAlgorithm": True,
                "signatureAlgorithm": "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
                "digestAlgorithm": "http://www.w3.org/2001/04/xmlenc#sha256",
            },
        }
        return d

    def _build_auth(self, request_data: dict, *, want_messages_signed: bool = False):
        # Imported lazily so a non-viz Dockerfile (missing libxmlsec1
        # system deps) doesn't crash on import of auth_service.
        try:
            from onelogin.saml2.auth import OneLogin_Saml2_Auth  # type: ignore
        except ImportError as exc:  # pragma: no cover - missing dep at import time
            raise SamlError(f"python3-saml is not available: {exc}") from exc
        return OneLogin_Saml2_Auth(
            request_data,
            self._settings_dict(want_messages_signed=want_messages_signed),
        )

    @staticmethod
    def _safe_request_data(*, host: str, https: bool, post_data: dict,
                           get_data: dict, path: str) -> dict:
        return {
            "https": "on" if https else "off",
            "http_host": host,
            "server_port": "443" if https else "80",
            "script_name": path,
            "get_data": get_data or {},
            "post_data": post_data or {},
        }

    # ── Leg 1: build the AuthnRequest redirect URL ───────────────────

    def build_authorization(
        self,
        *,
        host: str,
        https: bool,
        path: str,
        next_path: str,
        force_authn: bool = False,
    ) -> tuple[str, str, str]:
        """Return (redirect_url, relay_state, request_id).

        ``relay_state`` is a random opaque value the IdP echoes back via
        the SAMLResponse POST; the route signs it (with next_path) into
        the short-lived ``nx_saml`` cookie via ``core.tokens``.

        ``request_id`` is the ``ID`` of the AuthnRequest just built.
        python3-saml only validates an assertion's ``InResponseTo`` when
        ``process_response`` is handed this value, and it was never
        captured — so nothing tied a response to the request that asked
        for it, and an unsolicited IdP-initiated response was accepted
        as an ordinary login. The route stores it in the flow cookie and
        hands it back at the ACS.

        Setting ``force_authn=True`` (used by the 24h re-auth path)
        forces the IdP to re-authenticate the user even if their IdP
        session is still warm.
        """
        if not self.enabled:
            raise SamlError("SAML is not enabled/configured")
        request_data = self._safe_request_data(
            host=host, https=https, post_data={}, get_data={}, path=path,
        )
        auth = self._build_auth(request_data)
        relay_state = secrets.token_urlsafe(32)
        try:
            url = auth.login(
                return_to=relay_state,
                force_authn=force_authn,
                is_passive=False,
                set_nameid_policy=True,
            )
        except Exception as exc:  # noqa: BLE001 — library exceptions vary
            raise SamlError(f"AuthnRequest build failed: {exc}") from exc
        return url, relay_state, auth.get_last_request_id() or ""

    # ── Leg 2: process the ACS POST and verify the assertion ─────────

    async def fetch_identity(
        self,
        *,
        host: str,
        https: bool,
        path: str,
        post_data: dict,
        expected_request_id: str | None = None,
    ) -> ProviderIdentity:
        """Validate the SAML response and return a verified identity.

        Raises ``SamlError`` on any failure — the caller MUST NOT
        provision on a partial result.
        """
        if not self.enabled:
            raise SamlError("SAML is not enabled/configured")
        request_data = self._safe_request_data(
            host=host, https=https, post_data=post_data, get_data={}, path=path,
        )
        auth = self._build_auth(request_data)
        try:
            # Passing ``request_id`` is what makes python3-saml compare
            # ``InResponseTo``. Without it the library skips the check
            # entirely — it does not warn — so a response that answered
            # nobody's request validated like any other.
            #
            # ``None`` when the flow cookie predates this (self-draining
            # within the cookie's 10-minute life) or when the deployment
            # deliberately accepts IdP-initiated login.
            auth.process_response(request_id=expected_request_id or None)
        except Exception as exc:  # noqa: BLE001
            raise SamlError(f"SAML response parse failed: {exc}") from exc

        errors = auth.get_errors()
        if errors:
            reason = auth.get_last_error_reason() or "unknown"
            raise SamlError(f"SAML validation failed: {errors} / {reason}")
        if not auth.is_authenticated():
            raise SamlError("SAML response not authenticated")

        attrs = auth.get_attributes() or {}
        name_id = auth.get_nameid()
        if not name_id:
            raise SamlError("SAML response missing NameID")

        # Replay defence: the assertion ID must be one-time-use within
        # its own validity window. Reuse -> rejected.
        assertion_id = auth.get_last_assertion_id() or ""
        expires_epoch = _expires_epoch(auth)
        if assertion_id:
            is_new = await self._replay_cache.record(
                assertion_id, expires_epoch or (int(time.time()) + 600),
            )
            if not is_new:
                raise SamlError("SAML assertion replay rejected")

        # Build the synthetic claims dict the configurable mapper
        # consumes. ``__name_id__`` and ``__authn_instant__`` are
        # special-cased so the mapper can reference them via the
        # uniform path syntax (same shape as OIDC's id_token).
        claims: dict = {**attrs}
        claims["__name_id__"] = name_id
        authn_instant = _extract_authn_instant(auth)
        if authn_instant is not None:
            claims["__authn_instant__"] = authn_instant
        # Fallback: when no explicit email attribute is configured the
        # default mapping falls through and the NameID itself (often an
        # email-format identifier) becomes the email value via the
        # mapper's resolution order. Operators can override via the
        # claim_mapping spec.
        if "email" not in claims and "@" in str(name_id):
            claims["email"] = name_id

        try:
            identity = apply_claim_mapping(
                claims,
                kind="saml2",
                provider_slug=self._s.provider_slug,
                override=self._s.claim_mapping_override,
            )
        except ClaimMappingError as exc:
            raise SamlError(str(exc)) from exc

        # Stash the SAML-specific session_index in raw_claims for audit.
        # ProviderIdentity is frozen, so build a fresh instance with
        # the augmented raw_claims rather than mutating.
        from dataclasses import replace
        raw_claims = dict(identity.raw_claims)
        raw_claims["session_index"] = auth.get_session_index() or ""
        raw_claims["name_id"] = name_id
        return replace(identity, raw_claims=raw_claims)

    # ── SLO ──────────────────────────────────────────────────────────

    def process_slo(
        self,
        *,
        host: str,
        https: bool,
        path: str,
        post_data: dict,
        get_data: dict,
    ) -> Optional[str]:
        """Handle an IdP-initiated SLO request OR an SP-initiated SLO
        response. Returns a redirect URL when the IdP must be bounced
        next, or ``None`` when logout is complete.
        """
        if not self.enabled:
            raise SamlError("SAML is not enabled/configured")
        request_data = self._safe_request_data(
            host=host, https=https, post_data=post_data, get_data=get_data, path=path,
        )
        # A settings variant that requires the message itself to be
        # signed. ``wantMessagesSigned`` cannot be turned on globally —
        # ID-style IdPs sign the assertion and not the Response, and the
        # login path has to keep working with them — but a
        # ``LogoutRequest`` has no assertion to carry the signature, so
        # for SLO it is the only thing that can authenticate the
        # message. Unsigned, this route ended the presenting browser's
        # session on anyone's say-so, over GET, CSRF-exempt: an
        # ``<img src=".../sls">`` on any page was a logout. Annoyance
        # rather than compromise, but a logout nobody authenticated is
        # not a logout.
        auth = self._build_auth(request_data, want_messages_signed=True)
        try:
            url = auth.process_slo(
                delete_session_cb=None, keep_local_session=True,
            )
        except Exception as exc:  # noqa: BLE001
            raise SamlError(f"SAML SLO processing failed: {exc}") from exc
        errors = auth.get_errors()
        if errors:
            raise SamlError(f"SAML SLO errors: {errors}")
        return url

    # ── Metadata ─────────────────────────────────────────────────────

    def metadata_xml(self) -> str:
        """Return the SP metadata XML for the operator to register at
        the IdP. Public — no secrets in the document.
        """
        from onelogin.saml2.settings import OneLogin_Saml2_Settings  # type: ignore
        settings = OneLogin_Saml2_Settings(
            settings=self._settings_dict(), sp_validation_only=True,
        )
        metadata = settings.get_sp_metadata()
        errors = settings.validate_metadata(metadata)
        if errors:
            raise SamlError(f"SAML metadata invalid: {errors}")
        if isinstance(metadata, bytes):
            metadata = metadata.decode("utf-8")
        return metadata


# ── Helpers ──────────────────────────────────────────────────────────

def _extract_authn_instant(auth) -> Optional[int]:
    """Read ``AuthnInstant`` from the parsed assertion.

    ``python3-saml`` doesn't expose it on the Auth object; rely on the
    last response object's stored AuthnInstant when available, falling
    back to "now" (still useful as a re-auth anchor; conservative).
    """
    instant_str: Optional[str] = None
    try:
        # last_response is a ``OneLogin_Saml2_Response``; the
        # AuthnStatement is on the first assertion element.
        last = getattr(auth, "_last_response", None) or getattr(auth, "response", None)
        if last is not None:
            doc = getattr(last, "document", None)
            if doc is not None:
                # XPath the AuthnInstant attribute.
                from onelogin.saml2.xml_utils import OneLogin_Saml2_XML  # type: ignore
                nodes = OneLogin_Saml2_XML.query(
                    doc, "//saml:AuthnStatement",
                )
                if nodes:
                    instant_str = nodes[0].get("AuthnInstant") or None
    except Exception:  # noqa: BLE001 — best-effort parse
        instant_str = None
    if instant_str:
        try:
            # Handle the trailing-Z form by converting to +00:00.
            iso = instant_str.replace("Z", "+00:00") if instant_str.endswith("Z") else instant_str
            return int(datetime.fromisoformat(iso).timestamp())
        except (ValueError, TypeError):
            pass
    return int(datetime.now(timezone.utc).timestamp())


def _expires_epoch(auth) -> Optional[int]:
    """Pull the assertion expiry (``NotOnOrAfter``) so the replay cache
    can self-expire entries when their validity window closes."""
    try:
        v = auth.get_session_expiration()
    except Exception:  # noqa: BLE001
        v = None
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ── In-memory replay cache (tests + fallback) ────────────────────────


class _MemoryReplayCache:
    """Process-local replay cache. Tests and single-process dev ONLY.

    It cannot enforce one-time-use in any real deployment, and the ways
    it fails are not obvious, so they are worth naming:

    * viz-service runs 4 gunicorn workers per container and N replicas.
      Each holds its own dict, so a replayed assertion only has to land
      on a worker that has not seen it — probability ``1 - 1/4N`` on the
      first try.
    * ``ProviderRegistry`` rebuilds the provider every 60 s, and the
      rebuild constructs a NEW provider, hence a new empty dict. So even
      a single worker forgets every assertion once a minute, which is
      well inside the ``NotOnOrAfter`` window it is supposed to bound.

    This is why ``build_saml_provider`` takes an explicit cache and
    ``app/main.py`` refuses to serve SAML in prod without a shared one:
    the fallback silently *looks* like replay protection.
    """

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    async def record(self, assertion_id: str, expires_at_epoch: int) -> bool:
        now = int(time.time())
        # GC expired entries occasionally.
        if len(self._seen) > 10000:
            self._seen = {k: v for k, v in self._seen.items() if v > now}
        if assertion_id in self._seen and self._seen[assertion_id] > now:
            return False
        self._seen[assertion_id] = expires_at_epoch
        return True


def build_saml_provider(
    snap: ProviderConfigSnapshot,
    *,
    replay_cache=None,
) -> SamlProvider:
    """Factory for the registry. Materialises a working
    :class:`SamlProvider` from a snapshot.

    ``replay_cache`` must be supplied by anything serving real traffic —
    see ``_MemoryReplayCache`` for what omitting it actually costs. The
    registry binds it in ``app/main.py``; the default is for tests.
    """
    return SamlProvider(settings_from_snapshot(snap), replay_cache=replay_cache)


# ── Admin-time IdP metadata import ───────────────────────────────────


def parse_idp_metadata(xml: str) -> dict:
    """Turn an IdP's SAML metadata XML into the settings an operator would
    otherwise transcribe by hand — entity id, SSO/SLO URLs, signing cert.

    Lazy import, matching the rest of this module: a non-viz image may not
    have ``libxmlsec1`` installed, and importing python3-saml at module load
    would break ``auth_service`` everywhere rather than just here.

    Returns ``{"settings": {...}, "warnings": [...]}``. Raises
    :class:`SamlError` on unparseable input.
    """
    try:
        from onelogin.saml2.idp_metadata_parser import (  # type: ignore
            OneLogin_Saml2_IdPMetadataParser,
        )
    except ImportError as exc:  # pragma: no cover - missing system dep
        raise SamlError(f"python3-saml is not available: {exc}") from exc

    if not (xml or "").strip():
        raise SamlError("metadata XML is empty")

    try:
        parsed = OneLogin_Saml2_IdPMetadataParser.parse(xml)
    except Exception as exc:  # noqa: BLE001 — any XML fault is one error here
        raise SamlError(f"could not parse IdP metadata: {exc}") from exc

    idp = (parsed or {}).get("idp") or {}
    settings: dict = {}
    warnings: list[str] = []

    if idp.get("entityId"):
        settings["idp_entity_id"] = idp["entityId"]
    sso = (idp.get("singleSignOnService") or {}).get("url")
    if sso:
        settings["idp_sso_url"] = sso
    slo = (idp.get("singleLogoutService") or {}).get("url")
    if slo:
        settings["idp_slo_url"] = slo

    # python3-saml gives one cert under x509cert, or several under
    # x509certMulti when the IdP is mid-rotation. We take the signing cert;
    # this provider verifies signatures, so that is the one that matters.
    cert = idp.get("x509cert")
    if not cert:
        multi = idp.get("x509certMulti") or {}
        signing = multi.get("signing") or []
        if signing:
            cert = signing[0]
            if len(signing) > 1:
                warnings.append(
                    f"The IdP published {len(signing)} signing certificates "
                    "(a rotation is likely in progress). The first was "
                    "imported — confirm it is the active one."
                )
    if cert:
        settings["idp_x509_cert"] = _normalise_cert(cert)
    else:
        warnings.append(
            "No signing certificate found in the metadata. Assertions "
            "cannot be verified without one."
        )

    for required, label in (
        ("idp_entity_id", "entity ID"),
        ("idp_sso_url", "single sign-on URL"),
    ):
        if required not in settings:
            warnings.append(f"The metadata contains no {label}.")

    return {"settings": settings, "warnings": warnings}


async def fetch_idp_metadata(url: str, *, timeout: float = 10.0) -> str:
    """Fetch IdP metadata XML over HTTP.

    python3-saml ships ``parse_remote``, but it uses urllib synchronously and
    would block the event loop, so we fetch with httpx and hand the body to
    :func:`parse_idp_metadata`.

    Goes through ``outbound.fetch_metadata``, which refuses a target
    inside this deployment's own network and — importantly here — does
    not follow redirects. This call used to set
    ``follow_redirects=True``, which meant a public URL could bounce the
    request to an internal one after any pre-flight check had already
    passed. No IdP needs a redirect to serve its own metadata.
    """
    import httpx

    if not (url or "").strip():
        raise SamlError("metadata URL is required")
    try:
        resp = await fetch_metadata(url.strip(), timeout=timeout)
        return resp.text
    except BlockedOutboundRequest as exc:
        raise SamlError(f"metadata target refused: {exc}") from exc
    except httpx.HTTPError as exc:
        raise SamlError(f"could not fetch metadata: {exc}") from exc
