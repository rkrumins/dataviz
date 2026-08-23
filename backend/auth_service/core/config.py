"""
Auth-service configuration — environment-driven.

``JWT_SECRET_KEY`` MUST be set explicitly (>= 32 chars, and not one of
the placeholders this repo publishes) in every environment —
production, dev, and test. There is intentionally **no ephemeral
fallback**: a per-process random key silently invalidates every
outstanding session on restart and masks a missing-secret
misconfiguration in production. Absence, a too-weak value, or a known
placeholder fails fast — but at FIRST USE of the key ring, not at
import, and explicitly at startup via ``assert_signing_secret()``.

The distinction matters. Resolving at import made the secret a
precondition for importing anything under ``auth_service``, and
transitively for a great deal that never touches a token: the
aggregation control plane, which neither mints nor verifies one, died
with ``MissingSigningSecret`` on a repository import five links removed
from any signing code. A process that needs the key still refuses to
start without it; a process that does not is no longer held hostage to
it.

Local-dev convenience: when ``ENV`` is NOT a production-looking value
AND a ``.env`` / ``.env.dev`` file exists in CWD, we auto-source it
via ``python-dotenv`` so operators don't have to ``export
JWT_SECRET_KEY=...`` before every ``uvicorn`` invocation. Both gates
have to pass; either fails closed -> we never load the file. A stray
``.env`` baked into a prod container is therefore inert.
"""
import hashlib
import logging
import os
import re
from pathlib import Path

# ── Gated .env auto-load (local dev only) ────────────────────────────
# Two layered gates: ENV check + CWD file existence. ``override=False``
# keeps anything already exported in the shell authoritative over the
# file value. Missing python-dotenv falls back to the explicit-export
# path silently — operators can still ``export JWT_SECRET_KEY=...``.
_dev_env = os.getenv("ENV", "dev").strip().lower()
if _dev_env not in {"prod", "production"}:
    for _candidate in (".env.dev", ".env"):
        _path = Path(_candidate)
        if _path.is_file():
            try:
                from dotenv import load_dotenv as _load_dotenv  # noqa: WPS433
                _load_dotenv(_path, override=False)
            except ImportError:
                # python-dotenv missing -> stay on the bare-env path.
                pass
            break  # prefer .env.dev over .env; first hit wins

logger = logging.getLogger(__name__)

_DEFAULT_ALGORITHM = "HS256"
# HS256 needs a high-entropy shared secret. 32 chars is the floor we
# accept; anything shorter is rejected as weak.
_MIN_SECRET_LENGTH = 32

# Length is not strength. ``dev-secret-key-change-in-production`` is 34
# characters, so it cleared the floor above and booted clean — meaning a
# deployment that copied ``.env.example`` forward signed every token in
# production with a value published in this repository, and nothing
# anywhere reported a problem.
#
# There is no honest way to measure guessability from the string alone:
# entropy formulas score English-like passphrases highly and would hand
# out false confidence. So this denylists the specific placeholders this
# repository has published, which is the failure mode that actually
# happens — someone copies an example file rather than inventing a weak
# secret. ``.env.example`` no longer carries a value, but every ``.env``
# already derived from it does, so the entry stays.
#
# Adding a placeholder here is only half the job: the value maps to the
# file it came from so the error can name it, and
# ``test_no_example_file_ships_a_secret_that_would_boot`` enforces the
# converse — no example file may ship a secret a process would accept.
_PLACEHOLDER_SECRETS: dict[str, str] = {
    "dev-secret-key-change-in-production": ".env.example",
    "REPLACE_ME": "deploy/k8s/secret.example.yaml",
    "quickstart-demo-key": "docker-compose.quickstart.yml",
}
# RBAC Phase 1: short access-token TTL paired with the Redis revocation
# set. The design plan calls for ≤5 min so revocation lag stays within
# enterprise tolerances; the shipped .env files and the k8s configmap
# use 15, which is the documented ceiling.
#
# Raising this is not free and the cost used to be invisible. Permission
# claims ride in the token, so this is how long a revoked or demoted
# session keeps working, and the Redis tombstone has to be held for the
# whole window — which is why RBAC_REVOCATION_TTL_SECONDS is derived
# from this value rather than configured beside it, and why startup
# refuses to boot if an explicit override makes the tombstone shorter.
# See ``_assert_session_config_coherent`` in backend/app/main.py.
_DEFAULT_ACCESS_EXPIRY_MINUTES = 5
_DEFAULT_REFRESH_EXPIRY_DAYS = 7


class MissingSigningSecret(RuntimeError):
    """Raised at import when JWT_SECRET_KEY is unset or too weak."""


def _reject_placeholder(key: str, *, var: str) -> None:
    """Refuse a secret that is one of this repo's own example values.

    Checked before the length floor so the operator is told which file
    the value came from rather than being handed a generic "too weak" —
    the fix is "generate a real secret", and naming the source file is
    what makes that actionable.
    """
    origin = _PLACEHOLDER_SECRETS.get(key)
    if origin is None:
        return
    raise MissingSigningSecret(
        f"{var} is set to the placeholder value from {origin}. It is "
        "published in this repository, so anyone can forge tokens for "
        "this deployment. Generate a real secret with "
        "`python -c 'import secrets; print(secrets.token_urlsafe(48))'`."
    )


def _resolve_secret() -> str:
    key = os.getenv("JWT_SECRET_KEY")
    if not key:
        raise MissingSigningSecret(
            "JWT_SECRET_KEY is not set. Set a high-entropy secret "
            f"(>= {_MIN_SECRET_LENGTH} chars) in the environment — there "
            "is no ephemeral fallback. Generate one with "
            "`python -c 'import secrets; print(secrets.token_urlsafe(48))'`."
        )
    _reject_placeholder(key, var="JWT_SECRET_KEY")
    if len(key) < _MIN_SECRET_LENGTH:
        raise MissingSigningSecret(
            f"JWT_SECRET_KEY is too weak ({len(key)} chars); "
            f"require >= {_MIN_SECRET_LENGTH}."
        )
    return key


def _resolve_retired_secrets(*, active: str | None = None) -> tuple[str, ...]:
    """Keys accepted for VERIFICATION but never used to sign.

    Without this, changing ``JWT_SECRET_KEY`` invalidates every
    outstanding session the instant the new value lands — and during a
    rolling update, pods holding the old and new key both serve traffic,
    so the same user's requests flip between authenticated and 401 with
    no session affinity to pin them. Carrying the previous key here
    makes rotation and rollouts non-disruptive: sign with the new key,
    keep accepting the old one until the refresh TTL has drained, then
    drop it.

    Comma-separated, most-recent first. Each entry is held to the same
    length floor as the signing key, and duplicates of the active key
    are dropped so the ring never verifies the same secret twice.
    """
    raw = os.getenv("JWT_SECRET_KEY_PREVIOUS", "")
    keys: list[str] = []
    for candidate in raw.split(","):
        key = candidate.strip()
        if not key:
            continue
        _reject_placeholder(key, var="JWT_SECRET_KEY_PREVIOUS")
        if len(key) < _MIN_SECRET_LENGTH:
            raise MissingSigningSecret(
                f"JWT_SECRET_KEY_PREVIOUS contains a key that is too weak "
                f"({len(key)} chars); require >= {_MIN_SECRET_LENGTH}. "
                "Retired keys are still trusted for verification, so they "
                "carry the same strength requirement as the active one."
            )
        if key != (active if active is not None else _resolve_secret()) \
                and key not in keys:
            keys.append(key)
    return tuple(keys)


def key_id(secret: str) -> str:
    """Short, non-reversible fingerprint of a signing key.

    Emitted as the JWT ``kid`` header so verification selects the right
    key directly instead of trial-decoding, and logged at startup so two
    environments can be told apart without ever exposing the secret.
    """
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:8]


# ── The key ring, resolved on FIRST USE rather than at import ────────
#
# These four used to be plain module-level assignments, which made
# ``JWT_SECRET_KEY`` a precondition for *importing* anything under
# ``auth_service`` — and transitively for importing a great deal that has
# nothing to do with tokens.
#
# That is not hypothetical. The aggregation control plane, a process that
# neither mints nor verifies a token, died on its first ontology
# resolution with ``MissingSigningSecret``: a function-local
# ``from backend.app.db.repositories.stats_repo import ...`` initialised
# the repositories package, whose ``__init__`` eagerly imported all 21
# repos, one of which imports ``auth_service.providers.assurance``, whose
# package ``__init__`` imports ``oidc``, which imports this module. Five
# accidental couplings, ending in a batch worker being required to hold
# the token-signing key.
#
# Resolving lazily severs that. A process that never signs or verifies a
# token never touches these, so it never needs the secret. The guarantee
# that a process which DOES need it refuses to start is unchanged, but it
# is now stated rather than implied: ``assert_signing_secret()``, called
# from the API's startup, and no longer an accident of import order.
_KEY_RING: dict[str, object] = {}

_LAZY_KEY_RING_NAMES = frozenset({
    "JWT_SECRET_KEY",
    "JWT_SECRET_KEYS_PREVIOUS",
    "JWT_SECRET_KEY_ID",
    "JWT_VERIFICATION_KEYS",
})


def _key_ring_fingerprint() -> tuple[str | None, str | None]:
    """What the cached ring was resolved FROM.

    The ring is cached, and a cache with no notion of what produced it
    will happily serve a key the environment no longer configures. As a
    module-level constant that could not happen — the value was fixed to
    the module object, so re-importing produced a new one — but a plain
    dict survives a re-import and keeps answering with the old ring.

    That is not only a test concern, though the suite is where it
    surfaced: the key-ring tests re-import under a rotated secret, and a
    stale entry leaked out of them and broke nine unrelated tests with
    signature failures. Keying on the environment makes the cache
    self-invalidating, which is the property a constant had for free.
    """
    return os.getenv("JWT_SECRET_KEY"), os.getenv("JWT_SECRET_KEY_PREVIOUS")


def _build_key_ring() -> dict[str, object]:
    """Resolve and validate every key, once per configuration.

    Cached as a unit: the retired keys are validated against the active
    one, so resolving them independently could accept a ring the paired
    resolution would reject.
    """
    fingerprint = _key_ring_fingerprint()
    if _KEY_RING.get("_fingerprint") != fingerprint:
        _KEY_RING.clear()
        secret = _resolve_secret()
        previous = _resolve_retired_secrets(active=secret)
        _KEY_RING["_fingerprint"] = fingerprint
        _KEY_RING.update({
            "JWT_SECRET_KEY": secret,
            "JWT_SECRET_KEYS_PREVIOUS": previous,
            "JWT_SECRET_KEY_ID": key_id(secret),
            # (kid, key) pairs in verification-preference order: active first.
            "JWT_VERIFICATION_KEYS": tuple(
                (key_id(k), k) for k in (secret, *previous)
            ),
        })
    return _KEY_RING


#: The only algorithms this key ring can actually support. Every entry
#: in the ring is a secret STRING, so an asymmetric family would need a
#: PEM there and no code path loads one — and ``none`` would mean no
#: signature at all. ``JWT_ALGORITHM`` is read straight from the
#: environment, so without this a typo or a hostile env var is a silent
#: downgrade rather than a failed boot.
_SUPPORTED_ALGORITHMS = frozenset({"HS256", "HS384", "HS512"})


class UnsupportedAlgorithm(RuntimeError):
    """Raised at startup when ``JWT_ALGORITHM`` is not a symmetric HMAC."""


def assert_signing_secret() -> None:
    """Fail now if this process cannot sign tokens.

    Called from the startup of any service that mints or verifies them,
    so a missing or weak secret still stops the boot rather than
    surfacing as a 500 on the first login. The check that used to happen
    as a side effect of importing this module is this function; making it
    explicit is what lets processes that have no business holding the key
    import the module at all.

    Also validates the algorithm. Building the ring proves a key exists;
    it never proved the key could be used with the configured algorithm,
    so ``JWT_ALGORITHM=none`` cleared startup untouched.
    """
    if JWT_ALGORITHM not in _SUPPORTED_ALGORITHMS:
        raise UnsupportedAlgorithm(
            f"JWT_ALGORITHM={JWT_ALGORITHM!r} is not supported. This key "
            f"ring holds symmetric secrets, so the algorithm must be one "
            f"of {sorted(_SUPPORTED_ALGORITHMS)}."
        )
    _build_key_ring()


def reset_key_ring_cache() -> None:
    """Drop the resolved ring. For tests that re-point the environment."""
    _KEY_RING.clear()


def __getattr__(name: str):
    """PEP 562 lazy attributes for the key ring.

    Keeps ``from ...config import JWT_SECRET_KEY`` working unchanged for
    the handful of modules that genuinely need it, while leaving the
    module importable by everything that does not.
    """
    if name in _LAZY_KEY_RING_NAMES:
        return _build_key_ring()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", _DEFAULT_ALGORITHM)
JWT_EXPIRY_MINUTES: int = int(
    os.getenv("JWT_EXPIRY_MINUTES", str(_DEFAULT_ACCESS_EXPIRY_MINUTES))
)
JWT_REFRESH_EXPIRY_DAYS: int = int(
    os.getenv("JWT_REFRESH_EXPIRY_DAYS", str(_DEFAULT_REFRESH_EXPIRY_DAYS))
)
# Tolerance applied to ``exp``/``iat``/``nbf`` when verifying a token we
# issued ourselves. Without it those are exact boundaries, so a pod whose
# clock runs a second ahead of the one that minted the token rejects a
# token that has not expired — surfacing as a sign-out nobody can explain
# and nothing can reproduce.
#
# The IdP path has always allowed for this (``oidc.py`` validates
# provider claims with the same value); the asymmetry was that we did not
# extend the same tolerance to our own.
#
# Not free, and the cost is not local: an access token stays verifiable
# for this long past ``exp``, so the revocation tombstone in
# ``revocation_service`` has to outlive it or forced sign-out reopens the
# gap it was built to close. That derivation reads this value — changing
# it here moves both, and ``_assert_session_config_coherent`` refuses to
# boot if an explicit override breaks the pairing.
CLOCK_SKEW_LEEWAY_SECONDS: int = int(
    os.getenv("JWT_CLOCK_SKEW_LEEWAY_SECONDS", "60")
)
# ── Environment identity ─────────────────────────────────────────────
# Distinguishes one deployment of this app from another (``dev``,
# ``uat``, ...). Optional: leave it unset and every value below is
# byte-identical to what a single-environment deployment already emits.
#
# Set it when two environments can be open in the same browser. Cookie
# jars are keyed by DOMAIN, not by cluster, so two deployments that use
# the same cookie names overwrite each other's session even when they
# run on different clusters entirely. Because the tokens also carry
# identical ``iss``/``aud``, the receiving side cannot tell a foreign
# token from its own and the only symptom is an opaque
# "Signature verification failed" — the failure this setting removes.
#
# Constrained to a cookie-name-safe alphabet: it becomes part of the
# cookie name, and a stray separator would silently produce a cookie the
# browser refuses to store.
_ENV_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
AUTH_ENVIRONMENT_ID: str = os.getenv("AUTH_ENVIRONMENT_ID", "").strip().lower()
if AUTH_ENVIRONMENT_ID and not _ENV_ID_PATTERN.match(AUTH_ENVIRONMENT_ID):
    raise RuntimeError(
        f"AUTH_ENVIRONMENT_ID={AUTH_ENVIRONMENT_ID!r} is invalid. Use 1-32 "
        "chars of [a-z0-9_-] starting alphanumeric (e.g. 'dev', 'uat') — "
        "the value becomes part of the session cookie names."
    )

_BASE_ISSUER: str = os.getenv("JWT_ISSUER", "nexus-lineage")
# Binding the environment into the issuer is what turns a cross-environment
# token from an unexplained signature failure into an InvalidIssuerError —
# a condition the caller can actually recognise and recover from by
# evicting the cookie instead of looping on 401.
JWT_ISSUER: str = (
    f"{_BASE_ISSUER}:{AUTH_ENVIRONMENT_ID}" if AUTH_ENVIRONMENT_ID else _BASE_ISSUER
)
JWT_AUDIENCE: str = os.getenv("JWT_AUDIENCE", "nexus-lineage")

# Cookie configuration. SameSite=Lax is safe for top-level navigation;
# Secure is enforced by default and can only be disabled in dev/test.
COOKIE_SECURE: bool = os.getenv("AUTH_COOKIE_SECURE", "true").lower() != "false"
COOKIE_DOMAIN: str | None = os.getenv("AUTH_COOKIE_DOMAIN") or None
COOKIE_SAMESITE: str = os.getenv("AUTH_COOKIE_SAMESITE", "lax").lower()


# ── SSO session lifetime (Phase 2.E) ─────────────────────────────────
# Re-auth ceiling: SSO users must complete a fresh IdP authentication at
# least once every ``SSO_SESSION_MAX_AGE_HOURS`` (default 24). Enforced
# on every /refresh by comparing the provider-issued auth_time embedded
# in the refresh JWT. Local password sessions are NOT subject to this
# ceiling — their refresh cookie still lives ``JWT_REFRESH_EXPIRY_DAYS``.
SSO_SESSION_MAX_AGE_HOURS: float = float(
    os.getenv("SSO_SESSION_MAX_AGE_HOURS", "24")
)
SSO_SESSION_MAX_AGE_SECONDS: int = int(SSO_SESSION_MAX_AGE_HOURS * 3600)


# Absolute and idle ceilings for EVERY session, SSO or local.
#
# Rotation mints a brand-new 7-day refresh token every time, and nothing
# looked at when the family started. So a local password session that
# rotated at least once a week lived forever: a refresh cookie
# exfiltrated once was a permanent credential, and the only thing that
# could end it was an explicit revocation nobody knew to perform. SSO
# sessions had the 24h ``auth_time`` ceiling above; local sessions had
# no ceiling at all, which is the wrong way round given local login is
# the path without an IdP's conditional access in front of it.
#
# Two different questions, so two settings:
#   * ABSOLUTE — how long a single sign-in may last, measured from the
#     family's first mint. Caps the value of a stolen cookie.
#   * IDLE — how long a session may go unused, measured from the
#     previous rotation. Caps the value of an abandoned one, which is
#     the shared-workstation case.
#
# Both default to values a normal working pattern never reaches: the
# SPA renews about a minute ahead of a 15-minute access token, so an
# open tab rotates roughly four times an hour and only a genuinely
# untouched session approaches the idle bound.
#
# ``0`` disables either check, which is how a deployment that has
# deliberately accepted the old behaviour keeps it.
SESSION_ABSOLUTE_MAX_HOURS: float = float(
    os.getenv("SESSION_ABSOLUTE_MAX_HOURS", "168")   # 7 days
)
SESSION_ABSOLUTE_MAX_SECONDS: int = int(SESSION_ABSOLUTE_MAX_HOURS * 3600)

SESSION_IDLE_MAX_HOURS: float = float(
    os.getenv("SESSION_IDLE_MAX_HOURS", "12")
)
SESSION_IDLE_MAX_SECONDS: int = int(SESSION_IDLE_MAX_HOURS * 3600)


# Rotation grace window. Refresh-token rotation treats a re-presented
# jti as a stolen-chain replay and kills the whole family. That is right
# for an attacker and wrong for the far more common causes: two tabs
# refreshing on the same cookie within milliseconds of each other, a
# retried POST, a tab restored from bfcache, or a rotation whose
# Set-Cookie never made it back to the browser. Inside this window the
# re-presentation is answered with the successor the first caller
# already minted, so both racers converge on one token and nobody is
# signed out. Outside it, reuse detection is unchanged.
#
# The cost, stated plainly: an attacker who already holds the stolen
# refresh cookie and presents it within this window gets the same
# successor rather than tripping detection. That is the same bargain
# Auth0 and IdentityServer strike with their rotation reuse intervals.
# Set to 0 to refuse it — at the price of signing users out of every tab
# whenever two of them rotate at once, which is what this fixes.
REFRESH_ROTATION_GRACE_SECONDS: int = int(
    os.getenv("REFRESH_ROTATION_GRACE_SECONDS", "30")
)


# Accept a refresh token that has no server-side record, once, and write
# the record it should have had.
#
# Refresh validation is allow-by-record: a token is refused unless a row
# in ``refresh_tokens`` says otherwise. Every session that was already
# live when that deployed holds a token with no such row, because nothing
# wrote one — so without this, the deploy signs out the entire estate at
# each session's next rotation.
#
# Adoption is not a weakening of the new model so much as a continuation
# of the old one: under the previous denylist those same tokens were
# accepted with no row anywhere. But it *is* the old behaviour, so it is
# meant to be temporary. After one refresh lifetime
# (``JWT_REFRESH_EXPIRY_DAYS``) no record-less token can still exist:
# set this to false, and allow-by-record is unconditional.
#
# Every adoption logs at INFO naming the user and family, so the drain to
# zero is something an operator can watch rather than assume.
#
# The default is now OFF. The drain window closed long ago — no session
# minted before allow-by-record can still be inside its refresh lifetime
# — and leaving the ramp in place meant allow-by-record was not actually
# in force: a signed, unexpired refresh JWT with no row was still
# accepted and given one. That is the exact failure the inversion exists
# to remove, and it re-opens on any path that produces a token without
# its record: a restore from a snapshot taken before the row was
# written, or a row removed by hand.
#
# Set ``REFRESH_ADOPT_RECORDLESS=true`` for one deploy if an environment
# is somehow still draining; the family-revoked check runs before
# adoption either way, so a killed family stays killed.
REFRESH_ADOPT_RECORDLESS: bool = os.getenv(
    "REFRESH_ADOPT_RECORDLESS", "false",
).strip().lower() not in ("false", "0", "no", "off")


# ── Rate limits ──────────────────────────────────────────────────────
#
# Two different jobs, so two different keys.
#
# The per-IP limits are a coarse flood guard and nothing more. Behind a
# NAT or an ingress every user shares one address, so a tight per-IP cap
# does not stop an attacker (they have many addresses) while it does
# stop an office (they have one). The previous 10/minute on /login meant
# the eleventh person to arrive at 09:00 was refused. Real DoS handling
# belongs at the proxy; these values are sized so a legitimate tenant
# never reaches them — roughly 3x the peak a 2000-seat deployment
# produces during a morning sign-in rush.
#
# The per-account limits are the security control. They key on the
# account being attacked rather than the address attacking it, so they
# hold whether the traffic comes from one IP or ten thousand, and a
# spray against one user cannot be widened by renting more addresses.
RATELIMIT_LOGIN_PER_IP: str = os.getenv("RATELIMIT_LOGIN_PER_IP", "1000/minute")
RATELIMIT_SENSITIVE_PER_IP: str = os.getenv(
    "RATELIMIT_SENSITIVE_PER_IP", "200/minute"
)
# Refresh is keyed per rotation family (one browser session), so this is
# already per-user and needs no headroom for tenant size. A session needs
# ~4 rotations an hour; 30/minute is ~450x that.
RATELIMIT_REFRESH_PER_SESSION: str = os.getenv(
    "RATELIMIT_REFRESH_PER_SESSION", "30/minute"
)

# Counted on FAILURES only and cleared on a successful sign-in, so
# someone who signs in correctly twenty times a day is never throttled
# while a spray against one account stops at ten.
RATELIMIT_LOGIN_PER_ACCOUNT: str = os.getenv(
    "RATELIMIT_LOGIN_PER_ACCOUNT", "10 per 15 minutes"
)
# Counted on every request: password-reset responses are deliberately
# identical whether or not the account exists, so there is no failure to
# distinguish. This bounds mailbombing one person's inbox.
RATELIMIT_PASSWORD_RESET_PER_ACCOUNT: str = os.getenv(
    "RATELIMIT_PASSWORD_RESET_PER_ACCOUNT", "3/hour"
)


# ── Custom Identity Provider (Phase 2.B; dev/demo only) ──────────────
# The Custom provider reads a JWT-signed cookie/header that simulates an
# IdP returning AD-style attributes (first/last/email/external_id/claims/
# groups). It is hard-gated by AUTH_CUSTOM_PROVIDER_ENABLED and is
# refused at startup when ENV is a production-looking value.
ENV: str = os.getenv("ENV", "dev").strip().lower()
AUTH_CUSTOM_PROVIDER_ENABLED: bool = (
    os.getenv("AUTH_CUSTOM_PROVIDER_ENABLED", "false").lower() == "true"
)
_PROD_ENV_VALUES = {"prod", "production"}
if AUTH_CUSTOM_PROVIDER_ENABLED and ENV in _PROD_ENV_VALUES:
    raise RuntimeError(
        "AUTH_CUSTOM_PROVIDER_ENABLED=true is forbidden in production. "
        "The Custom IdP is a dev/demo mock that trusts a self-signed "
        "cookie payload; running it in prod would bypass real SSO. "
        "Set AUTH_CUSTOM_PROVIDER_ENABLED=false or change ENV."
    )
