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

from .base import ProviderCredentials, ProviderIdentity
from ..core.config import SAML_GROUPS_ATTRIBUTE

logger = logging.getLogger(__name__)


class SamlError(Exception):
    """Any failure in the SAML handshake (config, signature, conditions,
    replay). Routes map this to a generic auth failure — details are
    logged, never surfaced to the browser."""


@dataclass(frozen=True)
class SamlSettings:
    """Static configuration for the SAML SP.

    Loaded from environment via :func:`load_saml_settings`. The provider
    self-reports ``enabled`` only when the minimum fields are populated;
    a partial config is treated as disabled so routes can 404.
    """
    enabled: bool
    sp_entity_id: str
    sp_acs_url: str
    sp_slo_url: str
    idp_entity_id: str
    idp_sso_url: str
    idp_slo_url: str
    idp_x509_cert: str         # PEM body without headers, or full PEM
    sp_x509_cert: str          # required for signing/encryption (optional)
    sp_private_key: str
    name_id_format: str
    default_next: str = "/"


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


def load_saml_settings() -> SamlSettings:
    """Read SAML SP + IdP config from the environment.

    All fields are tolerant of empty values — the provider self-reports
    ``enabled=False`` whenever the minimum set is missing, so routes
    can 404 instead of 500 on a partial config.
    """
    enabled = os.getenv("SAML_ENABLED", "false").lower() == "true"
    return SamlSettings(
        enabled=enabled,
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
    def enabled(self) -> bool:
        s = self._s
        return bool(
            s.enabled
            and s.sp_entity_id and s.sp_acs_url
            and s.idp_entity_id and s.idp_sso_url
            and s.idp_x509_cert
        )

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

    def _settings_dict(self) -> dict:
        """Build the OneLogin settings dict from our static config."""
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
                "wantMessagesSigned": False,  # ID-style IdPs sign assertions only
                "wantAssertionsEncrypted": False,
                "wantNameIdEncrypted": False,
                "requestedAuthnContext": False,
                "rejectDeprecatedAlgorithm": True,
                "signatureAlgorithm": "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
                "digestAlgorithm": "http://www.w3.org/2001/04/xmlenc#sha256",
            },
        }
        return d

    def _build_auth(self, request_data: dict):
        # Imported lazily so a non-viz Dockerfile (missing libxmlsec1
        # system deps) doesn't crash on import of auth_service.
        try:
            from onelogin.saml2.auth import OneLogin_Saml2_Auth  # type: ignore
        except ImportError as exc:  # pragma: no cover - missing dep at import time
            raise SamlError(f"python3-saml is not available: {exc}") from exc
        return OneLogin_Saml2_Auth(request_data, self._settings_dict())

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
    ) -> tuple[str, str]:
        """Return (redirect_url, relay_state).

        ``relay_state`` is a random opaque value the IdP echoes back via
        the SAMLResponse POST; the route signs it (with next_path) into
        the short-lived ``nx_saml`` cookie via ``core.tokens``.

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
        return url, relay_state

    # ── Leg 2: process the ACS POST and verify the assertion ─────────

    def fetch_identity(
        self,
        *,
        host: str,
        https: bool,
        path: str,
        post_data: dict,
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
            auth.process_response()
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
            is_new = self._replay_cache.record(
                assertion_id, expires_epoch or (int(time.time()) + 600),
            )
            if not is_new:
                raise SamlError("SAML assertion replay rejected")

        email = _attr_first(attrs, ("email", "mail",
                                    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"))
        if not email:
            # NameID is often the email address — fall back to it.
            email = name_id
        email = (email or "").strip().lower()
        if not email:
            raise SamlError("SAML response missing email")

        first_name = _attr_first(attrs, ("given_name", "givenName", "firstName",
                                         "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"))
        last_name = _attr_first(attrs, ("family_name", "surname", "lastName", "sn",
                                        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"))

        groups = _extract_groups(attrs)
        auth_time = _extract_authn_instant(auth)

        return ProviderIdentity(
            provider="saml2",
            external_id=str(name_id),
            email=email,
            first_name=str(first_name or ""),
            last_name=str(last_name or ""),
            raw_claims={"attributes": attrs, "name_id": name_id,
                        "session_index": auth.get_session_index() or ""},
            groups=groups,
            auth_time=auth_time,
        )

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
        auth = self._build_auth(request_data)
        try:
            url = auth.process_slo(delete_session_cb=None, keep_local_session=True)
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

def _attr_first(attrs: dict, keys: tuple[str, ...]) -> Optional[str]:
    """Return the first value found under any of *keys*. SAML attributes
    are typically lists; we pick the first element."""
    for k in keys:
        v = attrs.get(k)
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            for item in v:
                if isinstance(item, str) and item.strip():
                    return item.strip()
        elif isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _extract_groups(attrs: dict) -> tuple[str, ...]:
    """Pull group membership out of the SAML attribute statement.

    Accepts the configured ``SAML_GROUPS_ATTRIBUTE`` (default ``groups``)
    and several common alternates IdPs use out of the box. Empty when
    no usable attribute is present.
    """
    candidates = (
        SAML_GROUPS_ATTRIBUTE,
        "groups",
        "memberOf",
        "Groups",
        "http://schemas.xmlsoap.org/claims/Group",
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    )
    for key in candidates:
        raw = attrs.get(key)
        if raw is None:
            continue
        if isinstance(raw, (list, tuple)):
            out = [g.strip() for g in raw if isinstance(g, str) and g.strip()]
        elif isinstance(raw, str):
            out = [g.strip() for g in raw.split(",") if g.strip()] if "," in raw else [raw.strip()] if raw.strip() else []
        else:
            continue
        if out:
            return tuple(out)
    return ()


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
    """Process-local replay cache used when no Redis-backed one is
    injected. Loses state across restarts — fine for tests + dev, never
    for prod. The real one is wired in ``backend/app/main.py``."""

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    def record(self, assertion_id: str, expires_at_epoch: int) -> bool:
        now = int(time.time())
        # GC expired entries occasionally.
        if len(self._seen) > 10000:
            self._seen = {k: v for k, v in self._seen.items() if v > now}
        if assertion_id in self._seen and self._seen[assertion_id] > now:
            return False
        self._seen[assertion_id] = expires_at_epoch
        return True
