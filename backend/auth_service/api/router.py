"""Cookie-based authentication endpoints (Phase 3 — slug-routed, multi-IdP).

Mounted at ``/api/v1/auth/``. All endpoints here go through the
``IdentityService`` on ``request.app.state`` so swapping the
in-process implementation for an HTTP client only requires touching
app startup.

SSO flows are slug-routed:

  GET  /auth/providers
  GET  /auth/{slug}/login                  -> start OIDC/SAML/custom
  GET  /auth/{slug}/callback                -> OIDC redirect URI
  POST /auth/{slug}/acs                     -> SAML ACS
  GET  /auth/{slug}/metadata                -> SAML SP metadata
  GET|POST /auth/{slug}/sls                 -> SAML SLO
  POST /auth/{slug}/mock                    -> custom dev cookie planter

Self-service identity linking (logged-in users only):

  GET    /me/identities                     -> list current user's links
  GET    /auth/identities/{slug}/link/start -> start link flow
  GET    /auth/identities/{slug}/link/callback -> finish link flow
  DELETE /me/identities/{identity_id}       -> self-service unlink

Phase 2's hardcoded ``/auth/oidc/{login,callback}``,
``/auth/saml/{metadata,login,acs,sls}``, and
``/auth/custom/{login,mock}`` are replaced. The boot seeder migrates
existing env-based deployments to a single provider row each
(``default-oidc``, ``default-saml2``, ``default-custom``) so the
previous URL space keeps working under the new shape.
"""
from __future__ import annotations

import hmac
import logging
from typing import Optional

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..cookies import (
    ACCESS_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
    clear_link_intent_cookie,
    clear_mock_identity_cookie,
    clear_oidc_cookie,
    clear_saml_cookie,
    clear_session_cookies,
    raise_if_foreign_session,
    read_access_cookie,
    read_link_intent_cookie,
    read_mock_identity_cookie,
    read_oidc_cookie,
    read_refresh_cookie,
    read_saml_cookie,
    set_mock_identity_cookie,
    set_oidc_cookie,
    set_saml_cookie,
    set_session_cookies,
)
from ..core.config import (
    AUTH_CUSTOM_PROVIDER_ENABLED,
    AUTH_ENVIRONMENT_ID,
    COOKIE_DOMAIN,
    COOKIE_SAMESITE,
    COOKIE_SECURE,
    JWT_ISSUER,
    JWT_SECRET_KEY_ID,
    JWT_VERIFICATION_KEYS,
)
from ..core.tokens import (
    create_mock_identity_token,
    decode_refresh_token,
    decode_token,
    create_oidc_state_token,
    create_saml_state_token,
    decode_link_intent_token,
    decode_oidc_state_token,
    decode_saml_state_token,
)
from ..interface import (
    IdentityService,
    InvalidCredentials,
    InvalidRefreshToken,
    LocalLoginDisabled,
    SSOAuthError,
    SsoReauthRequired,
    User,
)
from ..providers import (
    ProviderDisabled,
    ProviderNotFound,
    get_registry,
)
from ..providers.custom import CustomIdentityError, CustomIdentityProvider
from ..providers.oidc import OidcProvider

# SAML import is best-effort; the registry will refuse to materialise
# a saml2 provider when ``SAML_AVAILABLE`` is False, so we just need
# the type for isinstance checks.
try:
    from ..providers.saml2 import SamlProvider  # type: ignore
except ImportError:  # pragma: no cover
    SamlProvider = None  # type: ignore

logger = logging.getLogger(__name__)

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


# ── Request / response models ─────────────────────────────────────────


class LoginBody(BaseModel):
    email: str
    password: str


class SessionResponse(BaseModel):
    """Returned by /login and /me. The access token lives in the
    ``nx_access`` cookie — never in the response body."""
    model_config = ConfigDict(populate_by_name=True)
    user: User


class _Ack(BaseModel):
    ok: bool = True


class ProviderSummary(BaseModel):
    """One entry in the public ``/auth/providers`` catalog. Contains
    no secrets — operators can render the login UI directly off this
    list."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    slug: str
    display_name: str = ""
    kind: str
    priority: int = 100
    button_label: Optional[str] = None
    button_icon: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────


def _identity_service(request: Request) -> IdentityService:
    svc = getattr(request.app.state, "identity_service", None)
    if svc is None:
        raise RuntimeError(
            "IdentityService not configured on app.state. "
            "Set it during startup (see backend/app/main.py)."
        )
    return svc


def _safe_next(raw: str | None) -> str:
    """Only allow a same-site relative path. Anything that could escape
    the origin (scheme, host, protocol-relative ``//``) falls back to
    the app root — an open-redirect guard on the post-login bounce."""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


_LOGIN_FAILURE_PATH = "/login?sso_error=1"


def _describe_token(raw: str, kind: str) -> str:
    """Classify a presented session cookie for ``/auth/diagnostics``.

    Never returns token contents — only the verdict, plus the ``kid``
    when the token names a key we don't hold, which is the single most
    useful fact when two environments are being confused for each other.
    """
    try:
        kid = pyjwt.get_unverified_header(raw).get("kid") or "(none)"
    except pyjwt.InvalidTokenError:
        return "malformed"
    try:
        if kind == "refresh":
            decode_refresh_token(raw)
        else:
            decode_token(raw)
    except pyjwt.ExpiredSignatureError:
        return f"expired (kid={kid})"
    except pyjwt.InvalidIssuerError:
        return f"foreign: issued by another environment (kid={kid})"
    except pyjwt.InvalidAudienceError:
        return f"foreign: wrong audience (kid={kid})"
    except pyjwt.InvalidSignatureError:
        return f"foreign: signed by a key this instance does not hold (kid={kid})"
    except pyjwt.InvalidTokenError as exc:
        return f"invalid: {exc} (kid={kid})"
    return f"valid (kid={kid})"


def _read_link_intent(request: Request, *, provider_id: str) -> Optional[str]:
    """Read ``nx_link_intent`` and return the user_id when the cookie
    is present, validly signed, unexpired, and references the provider
    we're currently completing. Returns None otherwise — the caller
    then treats the flow as a normal login.

    Provider mismatch is treated as "no intent" rather than an error
    so a stale cookie from a half-finished link doesn't poison a
    subsequent fresh login. The cookie is cleared by the caller when
    it's been consumed."""
    raw = read_link_intent_cookie(request)
    if not raw:
        return None
    try:
        payload = decode_link_intent_token(raw)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return None
    if payload.get("provider_id") != provider_id:
        return None
    user_id = payload.get("user_id")
    return user_id if isinstance(user_id, str) and user_id else None


async def _resolve_link_intent(
    request: Request, svc, *, provider_id: str
) -> Optional[str]:
    """Return the link-intent user_id only when it matches the live
    session.

    Defense-in-depth: the signed ``nx_link_intent`` cookie carries the
    user_id captured when the link flow started, but the SSO callback
    must not blindly trust it. If the cookie were replayed in a
    different session (or no session is active), honouring it would bind
    the returned IdP identity to an account the current caller does not
    control. We therefore re-validate the access-cookie session and only
    keep the intent when its user_id matches. On mismatch we drop the
    intent (the flow falls through to a normal login) — the caller still
    clears the stale cookie."""
    intent_user_id = _read_link_intent(request, provider_id=provider_id)
    if intent_user_id is None:
        return None
    session_user = await svc.validate_session(read_access_cookie(request))
    if session_user is None or session_user.id != intent_user_id:
        logger.warning(
            "link-intent rejected: cookie user=%s does not match live "
            "session user=%s (provider=%s)",
            intent_user_id, getattr(session_user, "id", None), provider_id,
        )
        return None
    return intent_user_id


async def _require_sso_enabled(request: Request) -> None:
    """Raise 404 when the platform master kill-switch is off. We use
    404 (not 503) so an attacker can't probe the toggle's state."""
    svc = _identity_service(request)
    try:
        cfg = await svc.auth_config()
    except AttributeError:
        # Legacy service wiring without auth_config() — treat as
        # "enabled" so existing tests pass unchanged.
        return
    if not cfg.sso_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SSO is not configured")


async def _resolve_provider(slug: str, *, request: Request):
    """Slug -> provider instance; raises 404 on unknown / disabled OR
    when the platform master kill-switch is off."""
    await _require_sso_enabled(request)
    try:
        registry = get_registry()
        provider_id = await registry.resolve_slug(slug)
        provider = await registry.get(provider_id)
    except (ProviderNotFound, ProviderDisabled):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown SSO provider")
    except RuntimeError as exc:  # registry not configured
        logger.warning("Provider registry not configured: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "SSO temporarily unavailable",
        )
    return provider


async def _provider_snapshot(slug: str):
    """Lookup helper used by the public catalog and by the linking-
    policy / display_name pull-throughs in callbacks."""
    try:
        registry = get_registry()
        provider_id = await registry.resolve_slug(slug)
        return await registry.get_snapshot(provider_id)
    except (ProviderNotFound, ProviderDisabled):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown SSO provider")


# ── POST /auth/login ──────────────────────────────────────────────────


@router.post(
    "/login",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
@limiter.limit("10/minute")
async def login(
    request: Request,
    response: Response,
    body: LoginBody,
):
    svc = _identity_service(request)
    try:
        user, tokens = await svc.login(body.email, body.password)
    except LocalLoginDisabled:
        # Phase 4: SSO-only mode. Don't leak the existence of any
        # account; respond with a structured 403 so the FE can
        # redirect to the providers picker.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "local_login_disabled"},
        )
    except InvalidCredentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    set_session_cookies(response, tokens)
    logger.info("Login succeeded for user=%s", user.id)
    return SessionResponse(user=user)


# ── POST /auth/logout ─────────────────────────────────────────────────


@router.post("/logout", response_model=_Ack)
async def logout(request: Request, response: Response):
    svc = _identity_service(request)
    refresh = read_refresh_cookie(request)
    await svc.logout(refresh)
    clear_session_cookies(response, request)
    return _Ack()


# ── POST /auth/refresh ────────────────────────────────────────────────


@router.post(
    "/refresh",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
@limiter.limit("30/minute")
async def refresh(request: Request, response: Response):
    svc = _identity_service(request)
    token = read_refresh_cookie(request)
    if not token:
        clear_session_cookies(response, request)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing refresh token",
        )
    try:
        user, tokens = await svc.refresh(token)
    except SsoReauthRequired as exc:
        clear_session_cookies(response, request)
        logger.info("SSO re-auth required (provider=%s)", exc.provider)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "sso_reauth_required",
                "provider": exc.provider,
                "login_url": exc.login_url,
            },
        )
    except InvalidRefreshToken as exc:
        clear_session_cookies(response, request)
        if getattr(exc, "foreign", False):
            # The cookie was signed by a key outside this deployment's
            # ring, or carries another environment's issuer. Retrying
            # cannot help, so tell the frontend to stop refreshing and
            # start a clean login instead of looping on 401.
            logger.warning(
                "Refresh rejected as foreign (host=%s): %s — session "
                "cookies evicted across all scopes",
                request.url.hostname, exc,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "error": "session_foreign",
                    "message": (
                        "Session belongs to a different environment or "
                        "signing key; please sign in again."
                    ),
                },
            )
        logger.info("Refresh rejected: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token invalid or expired",
        )

    set_session_cookies(response, tokens)
    return SessionResponse(user=user)


# ── GET /auth/me ──────────────────────────────────────────────────────


@router.get(
    "/me",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
async def me(request: Request):
    svc = _identity_service(request)
    user = await svc.validate_session(read_access_cookie(request))
    if user is None:
        # This is the first call the app makes after a page load, so it
        # is where a foreign cookie usually surfaces. Classify before
        # answering, so the handler can evict it rather than leaving the
        # browser to re-present it on every route the user clicks.
        raise_if_foreign_session(request)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return SessionResponse(user=user)


# ── GET /auth/diagnostics ─────────────────────────────────────────────


class AuthDiagnostics(BaseModel):
    """Non-secret description of how THIS instance handles sessions.

    Deliberately unauthenticated: it is most needed exactly when nobody
    can authenticate. It exposes no key material — only the key
    fingerprints (``kid``) already published in every JWT header.
    """
    model_config = ConfigDict(populate_by_name=True)

    environment_id: str = Field(alias="environmentId")
    issuer: str
    cookie_names: dict[str, str] = Field(alias="cookieNames")
    active_kid: str = Field(alias="activeKid")
    accepted_kids: list[str] = Field(alias="acceptedKids")
    cookie_secure: bool = Field(alias="cookieSecure")
    cookie_domain: Optional[str] = Field(alias="cookieDomain")
    cookie_samesite: str = Field(alias="cookieSamesite")
    request_is_secure: bool = Field(alias="requestIsSecure")
    secure_cookie_would_be_dropped: bool = Field(
        alias="secureCookieWouldBeDropped"
    )
    session_cookies_presented: dict[str, str] = Field(
        alias="sessionCookiesPresented"
    )


@router.get(
    "/diagnostics",
    response_model=AuthDiagnostics,
    response_model_by_alias=True,
)
async def diagnostics(request: Request):
    """Explain why this instance is or isn't accepting the caller's session.

    Answers, without a shell on the pod, the three questions that a
    cross-environment session bug actually turns on: are these two
    deployments configured as distinct environments, do they share a
    signing key, and did the browser's cookies even arrive.
    """
    presented: dict[str, str] = {}
    for label, name in (
        ("access", ACCESS_COOKIE_NAME),
        ("refresh", REFRESH_COOKIE_NAME),
        ("csrf", CSRF_COOKIE_NAME),
    ):
        raw = request.cookies.get(name)
        if raw is None:
            presented[label] = "absent"
        elif label == "csrf":
            presented[label] = "present"
        else:
            presented[label] = _describe_token(raw, label)

    # Honour the proxy header: behind an ingress the TLS hop terminates
    # upstream, so request.url.scheme alone reports http and would
    # misdiagnose a correctly-secured deployment.
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    is_secure = (forwarded_proto or request.url.scheme).lower() == "https"

    return AuthDiagnostics(
        environment_id=AUTH_ENVIRONMENT_ID or "(unset)",
        issuer=JWT_ISSUER,
        cookie_names={
            "access": ACCESS_COOKIE_NAME,
            "refresh": REFRESH_COOKIE_NAME,
            "csrf": CSRF_COOKIE_NAME,
        },
        active_kid=JWT_SECRET_KEY_ID,
        accepted_kids=[kid for kid, _key in JWT_VERIFICATION_KEYS],
        cookie_secure=COOKIE_SECURE,
        cookie_domain=COOKIE_DOMAIN,
        cookie_samesite=COOKIE_SAMESITE,
        request_is_secure=is_secure,
        # The silent killer: a Secure cookie sent over plain HTTP is
        # discarded by the browser without any error, so login returns
        # 200 and the next request is anonymous.
        secure_cookie_would_be_dropped=COOKIE_SECURE and not is_secure,
        session_cookies_presented=presented,
    )


# ── GET /auth/providers (public catalog) ─────────────────────────────


@router.get("/providers", response_model=list[ProviderSummary])
async def list_providers(request: Request):
    """Return the public catalog of enabled IdPs.

    Used by the login page to render one button per provider. No
    secrets, no settings — only the bits the user-facing UI needs.

    Phase 4: when the platform master kill-switch
    (``app_auth_config.sso_enabled``) is off, returns ``[]`` — the
    user-facing login page treats this as "SSO is unavailable" and
    falls back to the password form.
    """
    svc = _identity_service(request)
    try:
        cfg = await svc.auth_config()
    except AttributeError:
        cfg = None
    if cfg is not None and not cfg.sso_enabled:
        return []
    try:
        registry = get_registry()
    except RuntimeError:
        # No registry configured (env-only deployment / tests). Return
        # an empty list so the FE renders only the password form.
        return []
    snaps = await registry.list_enabled()
    return [
        ProviderSummary(
            id=s.id, slug=s.slug, display_name=s.display_name,
            kind=s.kind, priority=s.priority,
            button_label=s.button_label, button_icon=s.button_icon,
        )
        for s in snaps
    ]


# ── /auth/{slug}/login ────────────────────────────────────────────────


def _request_https_host(request: Request) -> tuple[str, bool, str]:
    """Extract (host, is_https, path) for python3-saml's request_data
    builder. Honors X-Forwarded-* headers when running behind a proxy."""
    fwd_proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    https = fwd_proto.lower() == "https"
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.hostname or ""
    )
    path = request.url.path
    return host, https, path


@router.get("/{slug}/login")
async def sso_login(
    slug: str,
    request: Request,
    next: str | None = None,
    force: str | None = None,
):
    """Slug-routed SSO entry point. Dispatches to the right provider
    kind based on the registry row.

    The ``force=1`` flag is set by the daily SSO re-auth bounce; we
    pass it through to the provider so OIDC adds ``prompt=login`` and
    SAML sets ``ForceAuthn=true``.
    """
    provider = await _resolve_provider(slug, request=request)
    next_path = _safe_next(next)
    force_flag = (force or "").strip() in {"1", "true", "yes"}

    if isinstance(provider, OidcProvider):
        try:
            auth_url, flow = await provider.build_authorization(
                next_path, force_reauth=force_flag,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("OIDC authorize build failed (%s): %s", slug, exc)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "OIDC temporarily unavailable",
            )
        state_token = create_oidc_state_token(
            state=flow["state"], nonce=flow["nonce"],
            code_verifier=flow["code_verifier"],
            next_path=flow["next"],
        )
        resp = RedirectResponse(auth_url, status_code=status.HTTP_302_FOUND)
        set_oidc_cookie(resp, state_token)
        return resp

    if SamlProvider is not None and isinstance(provider, SamlProvider):
        host, https, path = _request_https_host(request)
        try:
            redirect_url, relay_state = provider.build_authorization(
                host=host, https=https, path=path,
                next_path=next_path, force_authn=force_flag,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("SAML authorize build failed (%s): %s", slug, exc)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "SAML temporarily unavailable",
            )
        state_token = create_saml_state_token(
            relay_state=relay_state, next_path=next_path,
        )
        resp = RedirectResponse(redirect_url, status_code=status.HTTP_302_FOUND)
        set_saml_cookie(resp, state_token)
        return resp

    if isinstance(provider, CustomIdentityProvider):
        return await _custom_login_flow(
            request, slug=slug, provider=provider, next_path=next_path,
        )

    raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown SSO provider kind")


# ── OIDC callback ─────────────────────────────────────────────────────


@router.get("/{slug}/callback")
async def oidc_callback(
    slug: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    provider = await _resolve_provider(slug, request=request)
    if not isinstance(provider, OidcProvider):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not an OIDC provider")
    svc = _identity_service(request)
    snap = await _provider_snapshot(slug)

    def _fail(reason: str, *, error_code: Optional[str] = None,
              email: Optional[str] = None) -> RedirectResponse:
        logger.info("OIDC callback failed (slug=%s): %s", slug, reason)
        target = _LOGIN_FAILURE_PATH
        if error_code:
            params = f"error_code={error_code}"
            if email:
                from urllib.parse import quote as _quote
                params += f"&email={_quote(email)}"
            target = f"/login?{params}"
        resp = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
        clear_oidc_cookie(resp)
        return resp

    if error or not code or not state:
        return _fail(f"idp_error={error or 'missing_code_or_state'}")

    raw_cookie = read_oidc_cookie(request)
    if not raw_cookie:
        return _fail("missing_flow_cookie")
    try:
        flow = decode_oidc_state_token(raw_cookie)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
        return _fail(f"bad_flow_cookie:{exc}")

    if not hmac.compare_digest(str(flow.get("state", "")), state):
        return _fail("state_mismatch")

    try:
        identity = await provider.fetch_identity(
            code=code,
            code_verifier=flow["code_verifier"],
            nonce=flow["nonce"],
        )
    except Exception as exc:  # noqa: BLE001 — OidcError etc.
        return _fail(f"token_or_idtoken:{exc}")

    link_intent_user_id = await _resolve_link_intent(
        request, svc, provider_id=snap.id,
    )

    try:
        user, tokens = await svc.complete_sso_login(
            identity,
            provider_id=snap.id,
            provider_slug=snap.slug,
            linking_policy=snap.linking_policy,
            link_intent_user_id=link_intent_user_id,
        )
    except SSOAuthError as exc:
        if str(exc) == "unsafe_auto_link":
            return _fail(str(exc), error_code="unsafe_auto_link",
                         email=identity.email)
        return _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(
        _safe_next(flow.get("next")), status_code=status.HTTP_302_FOUND,
    )
    set_session_cookies(response, tokens)
    clear_oidc_cookie(response)
    # Clear whenever a link-intent cookie was presented — matched or
    # rejected — so a stale/replayed cookie can't be reused.
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    logger.info("OIDC login succeeded (slug=%s, user=%s)", slug, user.id)
    return response


# ── SAML metadata / ACS / SLO ────────────────────────────────────────


@router.get("/{slug}/metadata")
async def saml_metadata(slug: str):
    provider = await _resolve_provider(slug, request=request)
    if SamlProvider is None or not isinstance(provider, SamlProvider):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a SAML provider")
    try:
        xml = provider.metadata_xml()
    except Exception as exc:  # noqa: BLE001
        logger.warning("SAML metadata failed (slug=%s): %s", slug, exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "SAML metadata unavailable",
        )
    return Response(content=xml, media_type="application/samlmetadata+xml")


@router.post("/{slug}/acs")
async def saml_acs(slug: str, request: Request):
    provider = await _resolve_provider(slug, request=request)
    if SamlProvider is None or not isinstance(provider, SamlProvider):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a SAML provider")
    svc = _identity_service(request)
    snap = await _provider_snapshot(slug)

    def _fail(reason: str, *, error_code: Optional[str] = None,
              email: Optional[str] = None) -> RedirectResponse:
        logger.info("SAML ACS failed (slug=%s): %s", slug, reason)
        target = _LOGIN_FAILURE_PATH
        if error_code:
            from urllib.parse import quote as _quote
            params = f"error_code={error_code}"
            if email:
                params += f"&email={_quote(email)}"
            target = f"/login?{params}"
        resp = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
        clear_saml_cookie(resp)
        return resp

    form = await request.form()
    saml_response = form.get("SAMLResponse")
    relay_state = form.get("RelayState")
    if not saml_response:
        return _fail("missing_SAMLResponse")

    raw_cookie = read_saml_cookie(request)
    if not raw_cookie:
        return _fail("missing_flow_cookie")
    try:
        flow = decode_saml_state_token(raw_cookie)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
        return _fail(f"bad_flow_cookie:{exc}")
    if not hmac.compare_digest(str(flow.get("rs", "")), str(relay_state or "")):
        return _fail("relay_state_mismatch")

    host, https, path = _request_https_host(request)
    try:
        identity = provider.fetch_identity(
            host=host, https=https, path=path,
            post_data={k: v for k, v in form.multi_items()},
        )
    except Exception as exc:  # noqa: BLE001
        return _fail(f"saml_validate:{exc}")

    link_intent_user_id = await _resolve_link_intent(
        request, svc, provider_id=snap.id,
    )

    try:
        user, tokens = await svc.complete_sso_login(
            identity,
            provider_id=snap.id,
            provider_slug=snap.slug,
            linking_policy=snap.linking_policy,
            link_intent_user_id=link_intent_user_id,
        )
    except SSOAuthError as exc:
        if str(exc) == "unsafe_auto_link":
            return _fail(str(exc), error_code="unsafe_auto_link",
                         email=identity.email)
        return _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(
        _safe_next(flow.get("next")), status_code=status.HTTP_302_FOUND,
    )
    set_session_cookies(response, tokens)
    clear_saml_cookie(response)
    # Clear whenever a link-intent cookie was presented — matched or
    # rejected — so a stale/replayed cookie can't be reused.
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    logger.info("SAML login succeeded (slug=%s, user=%s)", slug, user.id)
    return response


@router.api_route("/{slug}/sls", methods=["GET", "POST"])
async def saml_sls(slug: str, request: Request):
    provider = await _resolve_provider(slug, request=request)
    if SamlProvider is None or not isinstance(provider, SamlProvider):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a SAML provider")
    host, https, path = _request_https_host(request)
    if request.method == "POST":
        form = await request.form()
        post_data = {k: v for k, v in form.multi_items()}
        get_data: dict = {}
    else:
        post_data = {}
        get_data = dict(request.query_params)
    try:
        redirect_url = provider.process_slo(
            host=host, https=https, path=path,
            post_data=post_data, get_data=get_data,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("SAML SLO failed (slug=%s): %s", slug, exc)
        resp = Response(status_code=status.HTTP_204_NO_CONTENT)
        clear_session_cookies(resp, request)
        return resp

    refresh_token = read_refresh_cookie(request)
    if refresh_token:
        try:
            svc = _identity_service(request)
            await svc.logout(refresh_token)
        except Exception:  # noqa: BLE001
            pass

    resp = RedirectResponse(
        redirect_url or "/", status_code=status.HTTP_302_FOUND,
    )
    clear_session_cookies(resp, request)
    return resp


# ── Custom IdP (dev/demo) flow + mock endpoint ───────────────────────


class _MockIdentityBody(BaseModel):
    external_id: str
    email: str
    first_name: str = ""
    last_name: str = ""
    claims: dict = {}
    groups: list[str] = []
    auth_time: int | None = None


@router.post("/{slug}/mock")
async def custom_mock(
    slug: str,
    request: Request,
    response: Response,
    body: _MockIdentityBody,
):
    """Dev-only endpoint that HMAC-signs the supplied payload into the
    ``nx_mock_identity`` cookie. Resolves the provider via slug to
    ensure the cookie is only set for an actual ``custom`` row in the
    registry."""
    provider = await _resolve_provider(slug, request=request)
    if not isinstance(provider, CustomIdentityProvider):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a Custom provider")
    if not AUTH_CUSTOM_PROVIDER_ENABLED:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Custom IdP disabled")
    payload = body.model_dump()
    if payload.get("auth_time") is None:
        import time as _time
        payload["auth_time"] = int(_time.time())
    token = create_mock_identity_token(payload)
    set_mock_identity_cookie(response, token)
    return _Ack()


async def _custom_login_flow(
    request: Request, *, slug: str, provider: CustomIdentityProvider,
    next_path: str,
) -> Response:
    """Either complete a custom-IdP login (cookie present) or bounce
    to the frontend Dev-Login page (cookie absent)."""
    if not AUTH_CUSTOM_PROVIDER_ENABLED:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Custom IdP disabled")
    svc = _identity_service(request)
    snap = await _provider_snapshot(slug)
    raw = read_mock_identity_cookie(request)
    if not raw:
        from urllib.parse import quote
        target = f"/dev-login?next={quote(next_path)}&slug={quote(slug)}"
        return RedirectResponse(target, status_code=status.HTTP_302_FOUND)

    def _fail(reason: str) -> RedirectResponse:
        logger.info("Custom IdP login failed (slug=%s): %s", slug, reason)
        resp = RedirectResponse(
            "/login?sso_error=1", status_code=status.HTTP_302_FOUND,
        )
        clear_mock_identity_cookie(resp)
        return resp

    try:
        identity = provider.fetch_identity(raw)
    except CustomIdentityError as exc:
        return _fail(f"envelope_invalid:{exc}")

    link_intent_user_id = await _resolve_link_intent(
        request, svc, provider_id=snap.id,
    )

    try:
        user, tokens = await svc.complete_sso_login(
            identity,
            provider_id=snap.id,
            provider_slug=snap.slug,
            linking_policy=snap.linking_policy,
            link_intent_user_id=link_intent_user_id,
        )
    except SSOAuthError as exc:
        return _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(next_path, status_code=status.HTTP_302_FOUND)
    set_session_cookies(response, tokens)
    clear_mock_identity_cookie(response)
    # Clear whenever a link-intent cookie was presented — matched or
    # rejected — so a stale/replayed cookie can't be reused.
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    logger.info("Custom IdP login succeeded (slug=%s, user=%s)", slug, user.id)
    return response
