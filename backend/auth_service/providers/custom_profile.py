"""
Custom profile identity provider — a generic seam for enterprise IdPs
that never redirect the browser and instead *hand us the profile*.

The pattern this serves: on an internal network the user is already
authenticated by a corporate portal (or an auth proxy sitting in front
of the app). There is no OIDC dance and no SAML POST — the portal simply
parks a profile payload somewhere the app can read it:

    source='cookie'          a cookie on a shared parent domain
    source='local_storage'   window.localStorage[<key>]
    source='session_storage' window.sessionStorage[<key>]
    source='header'          a request header injected by the proxy

Every source yields one opaque string; this module turns that string
into a verified :class:`ProviderIdentity`. Field naming varies per
enterprise (``firstName`` vs ``given_name``, ``emailAddress`` vs
``mail``, a single ``fullName`` instead of two), so extraction is
delegated wholesale to :mod:`claim_mapper` and remapped by the operator
from the admin UI — no redeploy to onboard a new portal.

Trust model — read this before changing anything here
-----------------------------------------------------
``localStorage`` and proxy headers are **not** authentication. Anyone
with a browser console can write a storage key, and any client can send
a header unless the proxy strips inbound copies. So:

* The default ``payload_format='jwt'`` verifies an HS256/RS256 signature
  server-side, requires ``exp``, and bounds ``iat`` by
  ``max_age_seconds``. The transport is then just transport.
* ``payload_format='json'`` (no signature at all) is refused unless the
  operator sets ``trust_unsigned=True``.
* ``source='header'`` is refused unless the operator sets
  ``trusted_proxy_acknowledged=True``.

Both escape hatches are audited on every login by the route layer.

Settings live in the Fernet-encrypted ``idp_providers.settings`` blob;
``shared_secret`` is redacted on the way back out to the admin UI.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Optional

import jwt as pyjwt

from .base import ProviderCredentials, ProviderIdentity
from .claim_mapper import apply_claim_mapping, ClaimMappingError
from ..core.config import CLOCK_SKEW_LEEWAY_SECONDS
from .registry import ProviderConfigSnapshot

logger = logging.getLogger(__name__)


# Sources the browser hands us via JS (need the POST endpoint) vs the
# ones the server can read off the request itself.
BROWSER_STORAGE_SOURCES = frozenset({"local_storage", "session_storage"})
SERVER_READ_SOURCES = frozenset({"cookie", "header"})
VALID_SOURCES = BROWSER_STORAGE_SOURCES | SERVER_READ_SOURCES

VALID_ENCODINGS = frozenset({"none", "base64url", "url"})
VALID_FORMATS = frozenset({"jwt", "json"})
VALID_ALGS = frozenset({"HS256", "RS256"})

# Nested containers hoisted to the top level so a payload shaped like
# ``{"user": {...}}`` maps without the operator writing dotted paths.
_NESTED_CONTAINERS = ("claims", "profile", "user", "userProfile", "attributes",
                      "entitlements")


class CustomProfileError(Exception):
    """Any failure ingesting the profile payload — missing/invalid
    signature, expired, stale, malformed, or a configuration that
    refuses to run. Mapped to a generic login failure by the route;
    the precise reason is logged and audited, never shown to the user.
    """


class CustomProfileConfigError(CustomProfileError):
    """The provider row is misconfigured. Raised at build time so a bad
    row fails loudly instead of silently trusting the wrong thing."""


@dataclass(frozen=True)
class CustomProfileSettings:
    """Per-provider settings for a custom profile IdP.

    ``source_key`` is the cookie name, storage key, or header name
    depending on ``source``. ``shared_secret`` is the only secret here
    and is redacted by ``idp_provider_repo.redact_settings``.
    """
    provider_id: str = "custom-profile"
    provider_slug: str = "default-custom-profile"
    source: str = "cookie"
    source_key: str = ""
    encoding: str = "none"
    payload_format: str = "jwt"
    trust_unsigned: bool = False
    signing_alg: str = "HS256"
    shared_secret: str = ""
    public_key: str = ""
    issuer: str = ""
    audience: str = ""
    max_age_seconds: int = 300
    trusted_proxy_acknowledged: bool = False
    claim_mapping_override: dict = field(default_factory=dict)
    linking_policy: str = "strict"


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "t"}
    return bool(v)


def _as_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def settings_from_snapshot(snap: ProviderConfigSnapshot) -> CustomProfileSettings:
    s = snap.settings or {}
    return CustomProfileSettings(
        provider_id=snap.id,
        provider_slug=snap.slug,
        source=str(s.get("source") or "cookie").strip(),
        source_key=str(s.get("source_key") or "").strip(),
        encoding=str(s.get("encoding") or "none").strip(),
        payload_format=str(s.get("payload_format") or "jwt").strip(),
        trust_unsigned=_as_bool(s.get("trust_unsigned")),
        signing_alg=str(s.get("signing_alg") or "HS256").strip().upper(),
        shared_secret=str(s.get("shared_secret") or ""),
        public_key=str(s.get("public_key") or ""),
        issuer=str(s.get("issuer") or "").strip(),
        audience=str(s.get("audience") or "").strip(),
        max_age_seconds=_as_int(s.get("max_age_seconds"), 300),
        trusted_proxy_acknowledged=_as_bool(s.get("trusted_proxy_acknowledged")),
        claim_mapping_override=snap.claim_mapping or {},
        linking_policy=snap.linking_policy,
    )


def validate_settings(s: CustomProfileSettings) -> None:
    """Refuse a row that would either not work or would trust something
    the operator hasn't explicitly accepted. Called from the builder so
    the failure surfaces the moment the registry materialises the row.
    """
    if s.source not in VALID_SOURCES:
        raise CustomProfileConfigError(
            f"source must be one of {sorted(VALID_SOURCES)}, got '{s.source}'"
        )
    if not s.source_key:
        raise CustomProfileConfigError("source_key is required")
    if s.encoding not in VALID_ENCODINGS:
        raise CustomProfileConfigError(
            f"encoding must be one of {sorted(VALID_ENCODINGS)}, got '{s.encoding}'"
        )
    if s.payload_format not in VALID_FORMATS:
        raise CustomProfileConfigError(
            f"payload_format must be one of {sorted(VALID_FORMATS)}, "
            f"got '{s.payload_format}'"
        )
    if s.payload_format == "json" and not s.trust_unsigned:
        raise CustomProfileConfigError(
            "payload_format='json' carries no signature; set "
            "trust_unsigned=true to accept unverifiable profiles"
        )
    if s.source == "header" and not s.trusted_proxy_acknowledged:
        raise CustomProfileConfigError(
            "source='header' trusts a header the proxy must strip from "
            "inbound requests; set trusted_proxy_acknowledged=true to accept"
        )
    if s.payload_format == "jwt":
        if s.signing_alg not in VALID_ALGS:
            raise CustomProfileConfigError(
                f"signing_alg must be one of {sorted(VALID_ALGS)}, "
                f"got '{s.signing_alg}'"
            )
        if s.signing_alg == "HS256" and not s.shared_secret:
            raise CustomProfileConfigError(
                "signing_alg='HS256' requires shared_secret"
            )
        if s.signing_alg == "RS256" and not s.public_key:
            raise CustomProfileConfigError(
                "signing_alg='RS256' requires public_key (PEM)"
            )
    if s.max_age_seconds < 0:
        raise CustomProfileConfigError("max_age_seconds must be >= 0")


class _MemoryJtiCache:
    """Process-local single-use cache. Tests and single-process dev ONLY.

    Mirrors ``saml2._MemoryReplayCache``, and fails the same two ways,
    neither obvious:

    * viz-service runs 4 gunicorn workers per container across N
      replicas, each with its own dict, so a replayed payload only has
      to land on a worker that has not seen it.
    * ``ProviderRegistry`` rebuilds the provider every 60 s, and the
      rebuild constructs a new empty dict — so even one worker forgets
      every ``jti`` once a minute, well inside the payload's own TTL.

    Which is exactly why ``app/main.py`` refuses to serve a signed
    custom_profile provider in production without a shared store: this
    fallback silently *looks* like replay protection.
    """

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    async def record(self, token_id: str, expires_at_epoch: int) -> bool:
        now = int(time.time())
        # Opportunistic prune; the dict is bounded by the TTL either way.
        self._seen = {k: v for k, v in self._seen.items() if v > now}
        if token_id in self._seen:
            return False
        self._seen[token_id] = int(expires_at_epoch)
        return True


class CustomProfileProvider:
    """Custom profile IdP. Stateless — the route pulls the raw payload
    string from whichever source the row configures and hands it over.
    """

    name = "custom_profile"

    def __init__(
        self,
        settings: CustomProfileSettings | None = None,
        *,
        replay_cache=None,
    ) -> None:
        self._s = settings or CustomProfileSettings()
        # One-time-use enforcement for the payload's ``jti``. Injected
        # rather than constructed here so ``auth_service`` keeps importing
        # nothing from ``backend.app.*`` — the same wiring SAML uses,
        # bound in ``app/main.py``, which is also where production
        # refuses a signed provider that has no shared store.
        self._replay = replay_cache or _MemoryJtiCache()

    @property
    def settings(self) -> CustomProfileSettings:
        return self._s

    @property
    def slug(self) -> str:
        return self._s.provider_slug

    @property
    def provider_id(self) -> str:
        return self._s.provider_id

    @property
    def enabled(self) -> bool:
        return True

    @property
    def reads_from_browser(self) -> bool:
        """True when the payload can only be read by JS and posted back,
        False when the server reads it off the request directly."""
        return self._s.source in BROWSER_STORAGE_SOURCES

    # ── IdentityProvider protocol ────────────────────────────────────
    async def authenticate(
        self, credentials: ProviderCredentials, *, get_user_by_email,
    ) -> Optional[ProviderIdentity]:
        return None

    # ── Payload -> ProviderIdentity ──────────────────────────────────

    def _decode_transport(self, raw: str) -> str:
        """Undo the transport encoding. Cookies in particular are often
        URL-encoded or base64url'd because a raw JSON blob isn't a legal
        cookie value."""
        if self._s.encoding == "url":
            return urllib.parse.unquote(raw)
        if self._s.encoding == "base64url":
            # Tolerate the stripped padding that base64url encoders emit.
            padded = raw + "=" * (-len(raw) % 4)
            try:
                return base64.urlsafe_b64decode(padded).decode("utf-8")
            except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
                raise CustomProfileError(f"payload_undecodable:{exc}") from exc
        return raw

    def _verify_jwt(self, token: str) -> dict:
        key = (
            self._s.shared_secret
            if self._s.signing_alg == "HS256"
            else self._s.public_key
        )
        # ``iat`` and ``jti`` are required, not optional.
        #
        # ``exp`` alone was the only mandatory claim, and the age bound
        # below was written as ``if issued is not None`` — so a payload
        # with a far-future ``exp`` and NO ``iat`` skipped the freshness
        # check entirely, which is the opposite of what SSO.md:622
        # promises ("a portal minting a year-long token still can't hand
        # out a year-long session"). ``jti`` is what makes the payload
        # single-use; without it a copied token is replayable for its
        # whole lifetime, which was the entire replay hole.
        options: dict[str, Any] = {
            "require": ["exp", "iat", "jti"],
            # ``iat`` is validated below instead of here. pyjwt treats a
            # future ``iat`` as not-yet-valid with ZERO tolerance, so a
            # portal one second ahead of us failed every login — but its
            # ``leeway`` knob applies to ``exp`` as well, and a payload
            # that is single-use and short-lived should not also get a
            # grace period past its own expiry. Splitting them keeps
            # ``exp`` strict and tolerates skew only in the direction
            # where skew is the likely explanation.
            "verify_iat": False,
        }
        decode_kwargs: dict[str, Any] = {}
        if self._s.audience:
            decode_kwargs["audience"] = self._s.audience
        else:
            options["verify_aud"] = False
        if self._s.issuer:
            decode_kwargs["issuer"] = self._s.issuer
        try:
            payload = pyjwt.decode(
                token,
                key,
                algorithms=[self._s.signing_alg],
                options=options,
                **decode_kwargs,
            )
        except pyjwt.ExpiredSignatureError as exc:
            raise CustomProfileError("payload_expired") from exc
        except pyjwt.InvalidTokenError as exc:
            raise CustomProfileError(f"payload_invalid:{exc}") from exc
        if not isinstance(payload, dict):
            raise CustomProfileError("payload_malformed")

        # Bound the age independently of ``exp`` so a leaked payload has
        # a short useful life. ``iat`` is now in the required set above,
        # so a missing one is refused by the decode rather than silently
        # skipping this block.
        try:
            issued = int(payload["iat"])
        except (KeyError, TypeError, ValueError):
            raise CustomProfileError("payload_bad_iat") from None

        now = time.time()
        # A future ``iat`` matters beyond freshness: it feeds the 24h SSO
        # re-auth ceiling by default — claim_mapper's auth_time
        # candidates end in "iat" — so a future-dated payload yields a
        # negative session age and never trips that ceiling. Refused
        # rather than clamped, with enough tolerance that ordinary clock
        # drift between the portal and us is not a login outage.
        if (issued - now) > CLOCK_SKEW_LEEWAY_SECONDS:
            raise CustomProfileError("payload_future_iat")

        if self._s.max_age_seconds and (now - issued) > self._s.max_age_seconds:
            raise CustomProfileError("payload_stale")
        return payload

    def _parse_json(self, blob: str) -> dict:
        if not self._s.trust_unsigned:
            # Belt-and-braces: validate_settings already refused this
            # row, but never let an unsigned payload through on a code
            # path that skipped the builder.
            raise CustomProfileError("unsigned_not_permitted")
        try:
            payload = json.loads(blob)
        except (ValueError, TypeError) as exc:
            raise CustomProfileError(f"payload_malformed:{exc}") from exc
        if not isinstance(payload, dict):
            raise CustomProfileError("payload_malformed")
        return payload

    async def _assert_not_replayed(self, payload: dict) -> None:
        """Burn the payload's ``jti`` so it works exactly once.

        A signature proves the portal minted this payload. It says
        nothing about who is presenting it, so before this a copied
        payload — lifted from a shared machine, a proxy log, a browser
        extension reading localStorage — was a working credential for
        its whole lifetime, and produced a legitimately minted session
        of the attacker's own. There was nothing to revoke and no signal
        that it had happened.

        Not best-effort. A store failure raises, exactly as it does for
        SAML assertions and for the same reason: everything else in the
        auth path degrades because the token TTL is still a floor,
        whereas "we could not check for a replay" has no floor under it
        — it is the whole control.
        """
        if self._s.payload_format != "jwt":
            return  # unsigned rows have no jti to burn; see validate_settings
        jti = payload.get("jti")
        if not jti or not isinstance(jti, str):
            raise CustomProfileError("payload_missing_jti")
        try:
            exp = int(payload["exp"])
        except (KeyError, TypeError, ValueError):
            raise CustomProfileError("payload_bad_exp") from None

        if not await self._replay.record(jti, exp):
            raise CustomProfileError("payload_replayed")

    async def fetch_identity(self, raw: str) -> ProviderIdentity:
        """Validate the profile payload and return a verified identity.

        Raises :class:`CustomProfileError` on any failure.

        Async because the single-use check talks to the shared replay
        store. The redirect-based providers are already awaited here.
        """
        if not raw or not raw.strip():
            raise CustomProfileError("payload_missing")

        decoded = self._decode_transport(raw.strip())
        payload = (
            self._verify_jwt(decoded)
            if self._s.payload_format == "jwt"
            else self._parse_json(decoded)
        )
        # After verification, never before: burning a jti off an
        # unverified payload would let anyone invalidate a real one.
        await self._assert_not_replayed(payload)

        # Hoist one level of nesting so the operator maps ``firstName``
        # rather than ``user.firstName``. Dotted paths still work for
        # anything deeper — setdefault never shadows a top-level key.
        claims = {**payload}
        for container in _NESTED_CONTAINERS:
            nested = payload.get(container)
            if isinstance(nested, dict):
                for k, v in nested.items():
                    claims.setdefault(k, v)

        try:
            return apply_claim_mapping(
                claims,
                kind="custom_profile",
                provider_slug=self._s.provider_slug,
                override=self._s.claim_mapping_override,
            )
        except ClaimMappingError as exc:
            raise CustomProfileError(str(exc)) from exc


def build_custom_profile_provider(
    snap: ProviderConfigSnapshot,
    *,
    replay_cache=None,
) -> CustomProfileProvider:
    """Factory for the registry. Validates before returning so a
    misconfigured row raises here rather than at login time.

    ``replay_cache`` must be supplied by anything serving real traffic;
    ``app/main.py`` binds it, and refuses to build a signed-payload
    provider without one in production. The default is for tests.
    """
    settings = settings_from_snapshot(snap)
    validate_settings(settings)
    return CustomProfileProvider(settings, replay_cache=replay_cache)
