"""
Cookie-based authentication endpoints.

Mounted at ``/api/v1/auth/`` alongside the legacy router (which still owns
signup, password reset, and invite verification — those endpoints don't
issue session cookies). All endpoints here go through the
``IdentityService`` on ``request.app.state``, so swapping the in-process
implementation for an HTTP client only requires touching app startup.
"""
from __future__ import annotations

import hmac
import logging

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..cookies import (
    clear_mock_identity_cookie,
    clear_oidc_cookie,
    clear_saml_cookie,
    clear_session_cookies,
    read_access_cookie,
    read_mock_identity_cookie,
    read_oidc_cookie,
    read_refresh_cookie,
    read_saml_cookie,
    set_mock_identity_cookie,
    set_oidc_cookie,
    set_saml_cookie,
    set_session_cookies,
)
from ..core.config import AUTH_CUSTOM_PROVIDER_ENABLED
from ..core.tokens import (
    create_mock_identity_token,
    create_oidc_state_token,
    create_saml_state_token,
    decode_oidc_state_token,
    decode_saml_state_token,
)
from ..interface import (
    IdentityService,
    InvalidCredentials,
    InvalidRefreshToken,
    SSOAuthError,
    SsoReauthRequired,
    User,
)
from ..providers import get_provider
from ..providers.custom import CustomIdentityError

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
    """Tiny ack body for /logout and /refresh so clients can switch on it."""
    ok: bool = True


# ── Helpers ───────────────────────────────────────────────────────────

def _identity_service(request: Request) -> IdentityService:
    """Pull the configured IdentityService off the app. Configured in main.py."""
    svc = getattr(request.app.state, "identity_service", None)
    if svc is None:
        raise RuntimeError(
            "IdentityService not configured on app.state. "
            "Set it during startup (see backend/app/main.py)."
        )
    return svc


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
    """Authenticate by email + password.

    On success: sets ``nx_access``, ``nx_refresh``, and ``nx_csrf`` cookies
    and returns ``{ user }``. The access token is never in the response body.
    """
    svc = _identity_service(request)
    try:
        user, tokens = await svc.login(body.email, body.password)
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
    """Revoke the refresh-token family and clear all session cookies.

    Idempotent: returning ``ok=true`` regardless of whether a session was
    present so clients can call this freely (e.g. on every app boot).
    """
    svc = _identity_service(request)
    refresh = read_refresh_cookie(request)
    await svc.logout(refresh)
    clear_session_cookies(response)
    return _Ack()


# ── POST /auth/refresh ────────────────────────────────────────────────

@router.post(
    "/refresh",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
@limiter.limit("30/minute")
async def refresh(request: Request, response: Response):
    """Rotate the refresh token and reissue access + refresh + CSRF cookies.

    Returns the current ``user`` so the frontend can keep its in-memory
    profile fresh on long-lived tabs.
    """
    svc = _identity_service(request)
    token = read_refresh_cookie(request)
    if not token:
        clear_session_cookies(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing refresh token",
        )
    try:
        user, tokens = await svc.refresh(token)
    except SsoReauthRequired as exc:
        # The session is past the SSO daily ceiling. Clear cookies AND
        # surface a structured 401 body so the frontend can bounce the
        # user back to the IdP without prompting them to "click here to
        # log in" — silent and seamless.
        clear_session_cookies(response)
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
        clear_session_cookies(response)
        logger.info("Refresh rejected: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token invalid or expired",
        )

    set_session_cookies(response, tokens)
    return SessionResponse(user=user)


# ── OIDC (Authorization Code + PKCE) ──────────────────────────────────

# Generic, relative landing pages. Absolute URLs are never used so the
# callback can't be turned into an open redirect.
_OIDC_FAILURE_PATH = "/login?sso_error=1"


def _oidc_provider():
    """Return the registered, enabled OIDC provider or 404."""
    try:
        provider = get_provider("oidc")
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC is not configured")
    if not getattr(provider, "enabled", False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "OIDC is not configured")
    return provider


def _safe_next(raw: str | None) -> str:
    """Only allow a same-site relative path. Anything that could escape
    the origin (scheme, host, protocol-relative ``//``) falls back to
    the app root — an open-redirect guard on the post-login bounce."""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


@router.get("/oidc/login")
async def oidc_login(
    request: Request,
    next: str | None = None,
    force: str | None = None,
):
    """Leg 1: build the IdP authorization URL and 302 there.

    The handshake parameters (state / nonce / PKCE verifier) are signed
    into the short-lived, HttpOnly ``nx_oidc`` cookie — no server-side
    session store.

    ``force=1`` is set by the daily-SSO-re-auth bounce: the IdP gets
    ``prompt=login`` and ``max_age`` is pinned so it cannot short-
    circuit through a warm IdP session.
    """
    provider = _oidc_provider()
    next_path = _safe_next(next)
    force_reauth = (force or "").strip() in {"1", "true", "yes"}
    try:
        auth_url, flow = await provider.build_authorization(
            next_path, force_reauth=force_reauth,
        )
    except Exception as exc:  # noqa: BLE001 — config/network → generic 503
        logger.warning("OIDC authorize build failed: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "OIDC temporarily unavailable"
        )

    state_token = create_oidc_state_token(
        state=flow["state"],
        nonce=flow["nonce"],
        code_verifier=flow["code_verifier"],
        next_path=flow["next"],
    )
    response = RedirectResponse(auth_url, status_code=status.HTTP_302_FOUND)
    set_oidc_cookie(response, state_token)
    return response


@router.get("/oidc/callback")
async def oidc_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    """Leg 2: validate ``state``, exchange the code, verify the ID
    token, then find-or-provision and issue the session.

    Every failure path clears the flow cookie and bounces to a generic
    error page — the browser never sees the reason (it's audited).
    """
    provider = _oidc_provider()
    svc = _identity_service(request)

    def _fail(reason: str) -> RedirectResponse:
        logger.info("OIDC callback failed: %s", reason)
        resp = RedirectResponse(
            _OIDC_FAILURE_PATH, status_code=status.HTTP_302_FOUND
        )
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

    # Constant-time state comparison (CSRF defence for the callback).
    if not hmac.compare_digest(str(flow.get("state", "")), state):
        return _fail("state_mismatch")

    try:
        identity = await provider.fetch_identity(
            code=code,
            code_verifier=flow["code_verifier"],
            nonce=flow["nonce"],
        )
    except Exception as exc:  # noqa: BLE001 — OidcError etc. → generic
        return _fail(f"token_or_idtoken:{exc}")

    try:
        user, tokens = await svc.complete_sso_login(identity)
    except SSOAuthError as exc:
        return _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(
        _safe_next(flow.get("next")), status_code=status.HTTP_302_FOUND
    )
    set_session_cookies(response, tokens)
    clear_oidc_cookie(response)
    logger.info("OIDC login succeeded for user=%s", user.id)
    return response


# ── GET /auth/me ──────────────────────────────────────────────────────

@router.get(
    "/me",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
async def me(request: Request):
    """Validate the access cookie and return the current user.

    The frontend calls this on app boot to determine whether to render
    the dashboard (200) or redirect to /login (401).
    """
    svc = _identity_service(request)
    user = await svc.validate_session(read_access_cookie(request))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return SessionResponse(user=user)


# ── SAML 2.0 (Service Provider, HTTP-POST ACS) ────────────────────────

_SAML_FAILURE_PATH = "/login?sso_error=1"


def _saml_provider():
    """Return the registered, enabled SAML provider or 404."""
    try:
        provider = get_provider("saml2")
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SAML is not configured")
    if not getattr(provider, "enabled", False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SAML is not configured")
    return provider


def _request_https_host(request: Request) -> tuple[str, bool, str]:
    """Extract (host, is_https, path) for python3-saml's request_data
    builder. Honors X-Forwarded-* headers when running behind a proxy."""
    fwd_proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    https = fwd_proto.lower() == "https"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.hostname or ""
    path = request.url.path
    return host, https, path


@router.get("/saml/metadata")
async def saml_metadata(request: Request):
    """Public SP metadata XML — handed to the IdP operator to register
    this app as a relying party.
    """
    provider = _saml_provider()
    try:
        xml = provider.metadata_xml()
    except Exception as exc:  # noqa: BLE001
        logger.warning("SAML metadata generation failed: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "SAML metadata unavailable",
        )
    return Response(content=xml, media_type="application/samlmetadata+xml")


@router.get("/saml/login")
async def saml_login(
    request: Request,
    next: str | None = None,
    force: str | None = None,
):
    """Leg 1: redirect to the IdP with a signed AuthnRequest. The
    relay_state + next_path are signed into the short-lived ``nx_saml``
    cookie so the ACS handler can compare them on the way back.

    ``force=1`` sets ``ForceAuthn=true`` (used by the daily-SSO-re-auth
    bounce).
    """
    provider = _saml_provider()
    next_path = _safe_next(next)
    force_authn = (force or "").strip() in {"1", "true", "yes"}
    host, https, path = _request_https_host(request)
    try:
        redirect_url, relay_state = provider.build_authorization(
            host=host, https=https, path=path,
            next_path=next_path, force_authn=force_authn,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("SAML authorize build failed: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "SAML temporarily unavailable",
        )

    state_token = create_saml_state_token(
        relay_state=relay_state, next_path=next_path,
    )
    response = RedirectResponse(redirect_url, status_code=status.HTTP_302_FOUND)
    set_saml_cookie(response, state_token)
    return response


@router.post("/saml/acs")
async def saml_acs(request: Request):
    """Leg 2 (HTTP-POST): the IdP posts the signed SAMLResponse here.

    We validate the response (signature, conditions, audience, recipient,
    replay), find-or-provision the user, then 302 to the safe next path
    (or to the failure page).
    """
    provider = _saml_provider()
    svc = _identity_service(request)

    def _fail(reason: str) -> RedirectResponse:
        logger.info("SAML ACS failed: %s", reason)
        resp = RedirectResponse(
            _SAML_FAILURE_PATH, status_code=status.HTTP_302_FOUND,
        )
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

    # Constant-time RelayState comparison. SAML uses RelayState as the
    # CSRF binding — the IdP echoes it back verbatim.
    if not hmac.compare_digest(str(flow.get("rs", "")), str(relay_state or "")):
        return _fail("relay_state_mismatch")

    host, https, path = _request_https_host(request)
    try:
        identity = provider.fetch_identity(
            host=host, https=https, path=path,
            post_data={k: v for k, v in form.multi_items()},
        )
    except Exception as exc:  # noqa: BLE001 — SamlError etc. → generic
        return _fail(f"saml_validate:{exc}")

    try:
        user, tokens = await svc.complete_sso_login(identity)
    except SSOAuthError as exc:
        return _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(
        _safe_next(flow.get("next")), status_code=status.HTTP_302_FOUND,
    )
    set_session_cookies(response, tokens)
    clear_saml_cookie(response)
    logger.info("SAML login succeeded for user=%s", user.id)
    return response


@router.api_route("/saml/sls", methods=["GET", "POST"])
async def saml_sls(request: Request):
    """Single Logout — IdP-initiated or SP-initiated. Clears the local
    session and (when needed) bounces the user to the IdP to complete
    the global sign-out."""
    provider = _saml_provider()
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
        logger.warning("SAML SLO failed: %s", exc)
        response = Response(status_code=status.HTTP_204_NO_CONTENT)
        clear_session_cookies(response)
        return response

    # Best-effort revoke the local refresh family.
    refresh = read_refresh_cookie(request)
    if refresh:
        try:
            svc = _identity_service(request)
            await svc.logout(refresh)
        except Exception:  # noqa: BLE001
            pass

    response = RedirectResponse(
        redirect_url or "/", status_code=status.HTTP_302_FOUND,
    )
    clear_session_cookies(response)
    return response


# ── Custom IdP (dev/demo mock) ────────────────────────────────────────

_DEV_LOGIN_PAGE = "/dev-login"


def _custom_provider():
    """Return the registered Custom provider or 404. The provider is
    only registered at startup when ``AUTH_CUSTOM_PROVIDER_ENABLED`` is
    true and ``ENV`` is non-prod (enforced in ``core/config.py``)."""
    if not AUTH_CUSTOM_PROVIDER_ENABLED:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Custom IdP is not enabled",
        )
    try:
        provider = get_provider("custom")
    except KeyError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Custom IdP is not enabled",
        )
    return provider


class _MockIdentityBody(BaseModel):
    """Schema for ``POST /auth/custom/mock``. Mirrors the
    ``ProviderIdentity`` fields the custom provider expects, with
    permissive defaults so a dev can spin up an identity with just an
    email + groups."""
    external_id: str
    email: str
    first_name: str = ""
    last_name: str = ""
    claims: dict = {}
    groups: list[str] = []
    # Epoch seconds; defaults to "now" on the server side.
    auth_time: int | None = None


@router.post("/custom/mock")
async def custom_mock(request: Request, response: Response, body: _MockIdentityBody):
    """Dev-only: HMAC-sign the supplied identity payload into the
    ``nx_mock_identity`` cookie. The frontend Dev-Login page POSTs
    here then navigates to ``/auth/custom/login`` to actually log in.
    Refused outside dev (gated by ``AUTH_CUSTOM_PROVIDER_ENABLED``).
    """
    _custom_provider()  # raises 404 if disabled
    payload = body.model_dump()
    if payload.get("auth_time") is None:
        import time as _time
        payload["auth_time"] = int(_time.time())
    token = create_mock_identity_token(payload)
    set_mock_identity_cookie(response, token)
    return _Ack()


@router.get("/custom/login")
async def custom_login(request: Request, next: str | None = None):
    """Leg 2 + 3 in one shot: if the ``nx_mock_identity`` cookie is
    present, validate it and complete the SSO login. Otherwise bounce
    to the frontend Dev-Login page so the user can plant the cookie.
    """
    provider = _custom_provider()
    svc = _identity_service(request)
    next_path = _safe_next(next)

    raw = read_mock_identity_cookie(request)
    if not raw:
        target = f"{_DEV_LOGIN_PAGE}?next={next_path}"
        return RedirectResponse(target, status_code=status.HTTP_302_FOUND)

    def _fail(reason: str) -> RedirectResponse:
        logger.info("Custom IdP login failed: %s", reason)
        resp = RedirectResponse(
            "/login?sso_error=1", status_code=status.HTTP_302_FOUND,
        )
        clear_mock_identity_cookie(resp)
        return resp

    try:
        identity = provider.fetch_identity(raw)
    except CustomIdentityError as exc:
        return _fail(f"envelope_invalid:{exc}")

    try:
        user, tokens = await svc.complete_sso_login(identity)
    except SSOAuthError as exc:
        return _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(next_path, status_code=status.HTTP_302_FOUND)
    set_session_cookies(response, tokens)
    clear_mock_identity_cookie(response)
    logger.info("Custom IdP login succeeded for user=%s", user.id)
    return response
