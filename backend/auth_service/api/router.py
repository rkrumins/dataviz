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
  POST /auth/{slug}/browser-profile         -> custom_profile web-storage login

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
import secrets
from typing import Optional

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..cookies import (
    clear_dryrun_cookie,
    clear_link_intent_cookie,
    clear_mock_identity_cookie,
    clear_oidc_cookie,
    clear_saml_cookie,
    clear_session_cookies,
    read_access_cookie,
    read_dryrun_cookie,
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
from ..core.config import AUTH_CUSTOM_PROVIDER_ENABLED
from ..core.tokens import (
    create_mock_identity_token,
    create_oidc_state_token,
    create_saml_state_token,
    decode_dryrun_token,
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
from ..providers.assurance import assurance_for
from ..providers.custom import CustomIdentityError, CustomIdentityProvider
from ..providers.custom_profile import (
    BROWSER_STORAGE_SOURCES,
    CustomProfileError,
    CustomProfileProvider,
)
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
    # Non-secret, per-kind hints the login UI needs to start the flow.
    # Populated from a strict whitelist (see ``_public_config``) — never
    # the raw settings dict, which holds secrets.
    config: dict = Field(default_factory=dict)


# ── Helpers ───────────────────────────────────────────────────────────


def _identity_service(request: Request) -> IdentityService:
    svc = getattr(request.app.state, "identity_service", None)
    if svc is None:
        raise RuntimeError(
            "IdentityService not configured on app.state. "
            "Set it during startup (see backend/app/main.py)."
        )
    return svc


def _public_config(snap) -> dict:
    """Non-secret settings the login UI needs to start a flow.

    Strictly whitelisted per kind. ``custom_profile`` rows that read
    from browser storage need the storage key client-side; nothing else
    from ``settings`` is ever exposed, because that dict also holds
    ``shared_secret``.
    """
    if snap.kind != "custom_profile":
        return {}
    settings = snap.settings or {}
    source = str(settings.get("source") or "cookie")
    out: dict = {"source": source}
    if source in BROWSER_STORAGE_SOURCES:
        out["sourceKey"] = str(settings.get("source_key") or "")
    return out


def _safe_next(raw: str | None) -> str:
    """Only allow a same-site relative path. Anything that could escape
    the origin (scheme, host, protocol-relative ``//``) falls back to
    the app root — an open-redirect guard on the post-login bounce."""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


def _failure_ref() -> str:
    """A short handle for one failed sign-in.

    SSO failures are deliberately opaque to the user — telling them which
    of "expired assertion", "claim mapping resolved no email" or "JIT is
    disabled" occurred would leak configuration to anyone who can reach the
    login page. The cost is that a stuck user and the admin who can help
    them have nothing in common to search on, so the reason we already
    recorded stays unreachable.

    This is the bridge: random enough not to be guessable or countable,
    short enough to read down a phone line.
    """
    return secrets.token_hex(4)


async def _record_sso_failure(
    svc, *, ref: str, slug: str, provider_id: Optional[str], reason: str,
) -> None:
    """Write the failure to the audit log keyed by ``ref``.

    Best-effort: a login that already failed must not also 500 because the
    audit write did. Uses the standalone-transaction emitter so the record
    survives the caller's rollback.
    """
    emit = getattr(svc, "emit_audit", None)
    if emit is None:
        return
    try:
        await emit("user.sso_login_failed", {
            "ref": ref,
            "provider_slug": slug,
            "provider_id": provider_id,
            # The precise reason is admin-only by construction: it lives
            # here, never in the redirect the user sees.
            "reason": reason,
        })
    except Exception as exc:  # noqa: BLE001 — audit is best-effort
        logger.warning("SSO failure audit failed (slug=%s): %s", slug, exc)


def _failure_redirect(ref: str, *, error_code: Optional[str] = None,
                      email: Optional[str] = None) -> str:
    """Build the login-page URL for a failed SSO attempt, carrying ``ref``."""
    from urllib.parse import quote as _quote

    params = [f"ref={ref}"]
    if error_code:
        params.append(f"error_code={_quote(error_code)}")
        if email:
            params.append(f"email={_quote(email)}")
    else:
        params.append("sso_error=1")
    return "/login?" + "&".join(params)


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


def _is_dryrun(request: Request, *, provider_id: str) -> bool:
    """Whether this callback is a rehearsal rather than a login.

    The cookie is minted only by the admin-authed
    ``/admin/idp-providers/{id}/dry-run/start``, which is what stops this
    from being a way for an anonymous caller to probe identities. An
    expired or mismatched cookie simply means "not a dry-run" — the flow
    falls through to a real login, which is the safe direction to fail:
    the alternative is refusing a genuine sign-in over a stale cookie.
    """
    raw = read_dryrun_cookie(request)
    if not raw:
        return False
    try:
        payload = decode_dryrun_token(raw)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return False
    return payload.get("provider_id") == provider_id


def _dryrun_response(slug: str, outcome: dict) -> Response:
    """Render the would-be outcome. No session cookies, no rows written.

    Plain HTML rather than a redirect into the SPA: the result has to
    survive a cross-site landing (the SAML ACS is a POST from the IdP)
    and carrying it through a redirect would mean putting claim values in
    a URL. This is the one page in the auth surface an admin reads
    directly.
    """
    import html
    import json

    action = str(outcome.get("action", "unknown"))
    headline = {
        "sign_in_existing": "Would sign in as an existing user",
        "provision_new": "Would create a new user",
        "link_existing": "Would link to an existing user",
        "rejected": "Would be REFUSED",
    }.get(action, action)
    body = html.escape(json.dumps(outcome, indent=2, default=str))
    return Response(
        content=(
            "<!doctype html><meta charset=utf-8>"
            f"<title>Dry run: {html.escape(slug)}</title>"
            "<style>body{font:14px/1.5 ui-monospace,monospace;max-width:52rem;"
            "margin:3rem auto;padding:0 1rem}h1{font-size:1.1rem}"
            "pre{background:#f4f4f5;padding:1rem;border-radius:.5rem;"
            "overflow-x:auto}</style>"
            f"<h1>{html.escape(headline)}</h1>"
            f"<p>Provider <code>{html.escape(slug)}</code>. "
            "Nothing was written and no session was created — close this tab "
            "and you are still signed in as yourself.</p>"
            f"<pre>{body}</pre>"
        ),
        media_type="text/html",
    )


async def _require_sso_enabled(request: Request) -> None:
    """Raise 404 when the platform master kill-switch is off. We use
    404 (not 503) so an attacker can't probe the toggle's state."""
    svc = _identity_service(request)
    # Check for the method rather than catching AttributeError around the
    # await. The old form wrapped the CALL, so an AttributeError raised
    # anywhere *inside* auth_config() — a None snapshot, a renamed repo
    # field — was silently reinterpreted as "SSO is enabled". That is a
    # kill-switch that fails open: an operator flips SSO off, a partly-broken
    # config provider swallows it, and every /auth/{slug}/* route stays live.
    if not hasattr(svc, "auth_config"):
        # Legacy service wiring without auth_config() — treat as enabled.
        return
    cfg = await svc.auth_config()
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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return SessionResponse(user=user)


# ── GET /auth/providers (public catalog) ─────────────────────────────


async def _enabled_provider_summaries(request: Request, cfg) -> list[ProviderSummary]:
    """The public catalog, shared by ``/providers`` and ``/login-context``.

    No secrets, no settings — only the bits the user-facing UI needs.
    Returns ``[]`` when the master kill-switch is off or no registry is
    configured (env-only deployment / tests), so the login page falls back
    to the password form rather than erroring.
    """
    if cfg is not None and not cfg.sso_enabled:
        return []
    try:
        registry = get_registry()
    except RuntimeError:
        return []
    snaps = await registry.list_enabled()
    return [
        ProviderSummary(
            id=s.id, slug=s.slug, display_name=s.display_name,
            kind=s.kind, priority=s.priority,
            button_label=s.button_label, button_icon=s.button_icon,
            config=_public_config(s),
        )
        for s in snaps
    ]


@router.get("/providers", response_model=list[ProviderSummary])
async def list_providers(request: Request):
    """Return the public catalog of enabled IdPs.

    Superseded by ``/login-context`` for the login page, which needs the
    posture alongside the catalog. Kept because it is a published endpoint
    with no reason to break.
    """
    svc = _identity_service(request)
    # See _require_sso_enabled: probe for the method, don't wrap the await.
    cfg = await svc.auth_config() if hasattr(svc, "auth_config") else None
    return await _enabled_provider_summaries(request, cfg)


class LoginContext(BaseModel):
    """Everything the login page needs to decide what to render."""
    model_config = ConfigDict(populate_by_name=True)
    allow_local_login: bool = Field(alias="allowLocalLogin")
    email_first_login: bool = Field(alias="emailFirstLogin")
    providers: list[ProviderSummary] = Field(default_factory=list)


@router.get("/login-context", response_model=LoginContext,
            response_model_by_alias=True)
async def login_context(request: Request):
    """Catalog + posture in one call, so the login page can render the
    right shape on first paint.

    Without this the page has to assume a shape and hope: it rendered a
    password form even where ``allow_local_login`` was off, so the primary
    control on the page was one the server always refuses. It also fired an
    email-domain resolve on every deployment, including the ~99% with
    email-first off, because it had no way to know.

    The two booleans are disclosed to anonymous callers. That is
    deliberate: the page cannot be correct without them, and neither tells
    an attacker anything that attempting a login would not. The provider
    list is the same one ``/providers`` has always served publicly.

    Fails soft — a posture read that raises yields the permissive default
    (local login on, email-first off), which is the shape that always has a
    usable control on it. A locked-out login page is worse than a login
    page that offers a form the server may refuse.
    """
    svc = _identity_service(request)
    cfg = None
    if hasattr(svc, "auth_config"):
        try:
            cfg = await svc.auth_config()
        except Exception as exc:  # noqa: BLE001 — see docstring
            logger.warning("Login context: posture read failed: %s", exc)

    return LoginContext(
        allow_local_login=bool(getattr(cfg, "allow_local_login", True)),
        email_first_login=bool(getattr(cfg, "email_first_login", False)),
        providers=await _enabled_provider_summaries(request, cfg),
    )


class _ResolveBody(BaseModel):
    email: str


class ResolveResult(BaseModel):
    """Which provider, if any, an email address routes to."""
    model_config = ConfigDict(populate_by_name=True)
    provider: Optional[ProviderSummary] = None


@router.post("/resolve", response_model=ResolveResult,
             response_model_by_alias=True)
@limiter.limit("20/minute")
async def resolve_email_domain(request: Request, body: _ResolveBody):
    """Route an email address to its IdP (Home Realm Discovery).

    A row of provider buttons is a coin flip once an org has three IdPs, and
    it publishes the org's IdP topology to anyone who loads /login. Asking
    for the email first removes both problems.

    Off unless ``app_auth_config.email_first_login`` is on: this changes what
    every user sees, and a wrong domain mapping strands them with no visible
    alternative.

    Deliberately NOT an enumeration oracle. Every miss — feature off, unknown
    domain, disabled provider, malformed input — returns the same empty body,
    so it reveals nothing about which domains an org has configured. Rate
    limited like /login for the same reason.
    """
    svc = _identity_service(request)
    empty = ResolveResult(provider=None)

    cfg = await svc.auth_config() if hasattr(svc, "auth_config") else None
    if cfg is None or not getattr(cfg, "email_first_login", False):
        return empty
    if not cfg.sso_enabled:
        return empty

    _local, _, domain = (body.email or "").partition("@")
    if not domain:
        return empty

    resolver = getattr(svc, "resolve_email_domain", None)
    if resolver is None:
        return empty
    try:
        snap = await resolver(domain)
    except Exception as exc:  # noqa: BLE001 — a lookup fault is not a leak
        logger.warning("Email-domain resolve failed: %s", exc)
        return empty
    if snap is None or not snap.enabled:
        return empty

    return ResolveResult(provider=ProviderSummary(
        id=snap.id, slug=snap.slug, display_name=snap.display_name,
        kind=snap.kind, priority=snap.priority,
        button_label=snap.button_label, button_icon=snap.button_icon,
        config=_public_config(snap),
    ))


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

    if isinstance(provider, CustomProfileProvider):
        return await _custom_profile_login_flow(
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

    async def _fail(reason: str, *, error_code: Optional[str] = None,
                    email: Optional[str] = None) -> RedirectResponse:
        ref = _failure_ref()
        logger.info("OIDC callback failed (slug=%s, ref=%s): %s", slug, ref, reason)
        await _record_sso_failure(
            svc, ref=ref, slug=slug, provider_id=snap.id, reason=reason,
        )
        resp = RedirectResponse(
            _failure_redirect(ref, error_code=error_code, email=email),
            status_code=status.HTTP_302_FOUND,
        )
        clear_oidc_cookie(resp)
        return resp

    if error or not code or not state:
        return await _fail(f"idp_error={error or 'missing_code_or_state'}")

    raw_cookie = read_oidc_cookie(request)
    if not raw_cookie:
        return await _fail("missing_flow_cookie")
    try:
        flow = decode_oidc_state_token(raw_cookie)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
        return await _fail(f"bad_flow_cookie:{exc}")

    if not hmac.compare_digest(str(flow.get("state", "")), state):
        return await _fail("state_mismatch")

    try:
        identity = await provider.fetch_identity(
            code=code,
            # The state token stores the PKCE verifier as ``cv`` (see
            # ``create_oidc_state_token``); this read used the pre-token
            # field name, so it raised KeyError — swallowed by the except
            # below into ``token_or_idtoken:'code_verifier'``. Every OIDC
            # sign-in failed there, and failed looking like an IdP problem.
            code_verifier=flow["cv"],
            nonce=flow["nonce"],
        )
    except Exception as exc:  # noqa: BLE001 — OidcError etc.
        return await _fail(f"token_or_idtoken:{exc}")

    # A rehearsal stops here: the assertion has been verified, which is the
    # half that actually breaks, and the rest is reported rather than done.
    if _is_dryrun(request, provider_id=snap.id):
        outcome = await svc.preview_sso_login(
            identity, provider_id=snap.id,
            linking_policy=snap.linking_policy,
        )
        resp = _dryrun_response(slug, outcome)
        clear_oidc_cookie(resp)
        clear_dryrun_cookie(resp)
        return resp

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
            assurance=assurance_for(snap.kind, snap.settings),
        )
    except SSOAuthError as exc:
        if str(exc) == "unsafe_auto_link":
            return await _fail(str(exc), error_code="unsafe_auto_link",
                         email=identity.email)
        return await _fail(f"sso_login_rejected:{exc}")

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
async def saml_metadata(slug: str, request: Request):
    # ``request`` is required by _resolve_provider -> _require_sso_enabled.
    # It was missing here, so this route raised NameError -> 500 on every
    # call — and it is the route an operator needs to register the SP at
    # the IdP, so SAML onboarding could never get past step one.
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

    async def _fail(reason: str, *, error_code: Optional[str] = None,
                    email: Optional[str] = None) -> RedirectResponse:
        ref = _failure_ref()
        logger.info("SAML ACS failed (slug=%s, ref=%s): %s", slug, ref, reason)
        await _record_sso_failure(
            svc, ref=ref, slug=slug, provider_id=snap.id, reason=reason,
        )
        resp = RedirectResponse(
            _failure_redirect(ref, error_code=error_code, email=email),
            status_code=status.HTTP_302_FOUND,
        )
        clear_saml_cookie(resp)
        return resp

    form = await request.form()
    saml_response = form.get("SAMLResponse")
    relay_state = form.get("RelayState")
    if not saml_response:
        return await _fail("missing_SAMLResponse")

    raw_cookie = read_saml_cookie(request)
    if not raw_cookie:
        return await _fail("missing_flow_cookie")
    try:
        flow = decode_saml_state_token(raw_cookie)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
        return await _fail(f"bad_flow_cookie:{exc}")
    if not hmac.compare_digest(str(flow.get("rs", "")), str(relay_state or "")):
        return await _fail("relay_state_mismatch")

    host, https, path = _request_https_host(request)
    try:
        identity = provider.fetch_identity(
            host=host, https=https, path=path,
            post_data={k: v for k, v in form.multi_items()},
        )
    except Exception as exc:  # noqa: BLE001
        return await _fail(f"saml_validate:{exc}")

    # See the OIDC callback: a rehearsal reports and stops.
    if _is_dryrun(request, provider_id=snap.id):
        outcome = await svc.preview_sso_login(
            identity, provider_id=snap.id,
            linking_policy=snap.linking_policy,
        )
        resp = _dryrun_response(slug, outcome)
        clear_saml_cookie(resp)
        clear_dryrun_cookie(resp)
        return resp

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
            assurance=assurance_for(snap.kind, snap.settings),
        )
    except SSOAuthError as exc:
        if str(exc) == "unsafe_auto_link":
            return await _fail(str(exc), error_code="unsafe_auto_link",
                         email=identity.email)
        return await _fail(f"sso_login_rejected:{exc}")

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
        clear_session_cookies(resp)
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
    clear_session_cookies(resp)
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

    async def _fail(reason: str) -> RedirectResponse:
        ref = _failure_ref()
        logger.info("Custom IdP login failed (slug=%s, ref=%s): %s",
                    slug, ref, reason)
        await _record_sso_failure(
            svc, ref=ref, slug=slug, provider_id=snap.id, reason=reason,
        )
        resp = RedirectResponse(
            _failure_redirect(ref), status_code=status.HTTP_302_FOUND,
        )
        clear_mock_identity_cookie(resp)
        return resp

    try:
        identity = provider.fetch_identity(raw)
    except CustomIdentityError as exc:
        return await _fail(f"envelope_invalid:{exc}")

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
            assurance=assurance_for(snap.kind, snap.settings),
        )
    except SSOAuthError as exc:
        return await _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(next_path, status_code=status.HTTP_302_FOUND)
    set_session_cookies(response, tokens)
    clear_mock_identity_cookie(response)
    # Clear whenever a link-intent cookie was presented — matched or
    # rejected — so a stale/replayed cookie can't be reused.
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    logger.info("Custom IdP login succeeded (slug=%s, user=%s)", slug, user.id)
    return response


# ── Custom profile IdP (cookie / browser storage / header) ───────────


class _BrowserProfileBody(BaseModel):
    """Payload the login page reads out of local/sessionStorage and
    posts back. Opaque to the client — it's verified server-side."""
    payload: str


async def _audit_degraded_trust(
    svc, *, provider, snap, via: str,
) -> None:
    """Record that a login was accepted through a channel we cannot
    cryptographically verify, before attempting the login itself.

    Two independent escape hatches exist and each gets its own event so
    an auditor can grep for either: an unsigned payload
    (``trust_unsigned``) and a proxy-injected header
    (``trusted_proxy_acknowledged``). Best-effort — an audit failure
    must never block a login.
    """
    emit = getattr(svc, "emit_audit", None)
    if emit is None:
        return
    events: list[str] = []
    if provider.settings.payload_format == "json":
        events.append("user.sso_unsigned_accepted")
    if provider.settings.source == "header":
        events.append("user.sso_header_accepted")
    for event_type in events:
        try:
            await emit(event_type, {
                "provider_id": snap.id,
                "provider_slug": snap.slug,
                "source": provider.settings.source,
                "source_key": provider.settings.source_key,
                "via": via,
            })
        except Exception as exc:  # noqa: BLE001 — audit is best-effort
            logger.warning("Degraded-trust audit failed (slug=%s): %s",
                           snap.slug, exc)


async def _complete_custom_profile(
    request: Request, *, identity, provider: CustomProfileProvider, snap,
):
    """Shared tail for both custom-profile entry points: audit the trust
    posture, resolve any link intent, mint the session.

    Raises ``SSOAuthError`` when the service refuses the login; the two
    callers render that differently (redirect vs JSON), so it isn't
    swallowed here.
    """
    svc = _identity_service(request)
    await _audit_degraded_trust(
        svc, provider=provider, snap=snap, via=provider.settings.source,
    )
    link_intent_user_id = await _resolve_link_intent(
        request, svc, provider_id=snap.id,
    )
    return await svc.complete_sso_login(
        identity,
        provider_id=snap.id,
        provider_slug=snap.slug,
        linking_policy=snap.linking_policy,
        link_intent_user_id=link_intent_user_id,
        assurance=assurance_for(snap.kind, snap.settings),
    )


async def _custom_profile_login_flow(
    request: Request, *, slug: str, provider: CustomProfileProvider,
    next_path: str,
) -> Response:
    """``GET /auth/{slug}/login`` for a custom-profile row.

    Cookie and header sources are readable server-side, so they complete
    right here as a plain redirect — no JS, and it works with an
    HttpOnly corporate cookie. Browser-storage sources can't be read
    from the server, so we bounce to the frontend page that reads the
    key and posts it to ``/{slug}/browser-profile``.

    Both paths matter for the 24h SSO re-auth bounce, which sends the
    browser to this endpoint with ``force=1``.
    """
    snap = await _provider_snapshot(slug)
    source = provider.settings.source

    if source in BROWSER_STORAGE_SOURCES:
        from urllib.parse import quote
        target = f"/portal-login?next={quote(next_path)}&slug={quote(slug)}"
        return RedirectResponse(target, status_code=status.HTTP_302_FOUND)

    raw = (
        request.headers.get(provider.settings.source_key)
        if source == "header"
        else request.cookies.get(provider.settings.source_key)
    )

    async def _fail(reason: str, *, error_code: Optional[str] = None,
                    email: Optional[str] = None) -> RedirectResponse:
        ref = _failure_ref()
        logger.info("Custom profile login failed (slug=%s, ref=%s): %s",
                    slug, ref, reason)
        await _record_sso_failure(
            _identity_service(request), ref=ref, slug=slug,
            provider_id=snap.id, reason=reason,
        )
        return RedirectResponse(
            _failure_redirect(ref, error_code=error_code, email=email),
            status_code=status.HTTP_302_FOUND,
        )

    if not raw:
        return await _fail(f"payload_missing_from_{source}")

    try:
        identity = provider.fetch_identity(raw)
    except CustomProfileError as exc:
        return await _fail(f"payload_rejected:{exc}")

    try:
        user, tokens = await _complete_custom_profile(
            request, identity=identity, provider=provider, snap=snap,
        )
    except SSOAuthError as exc:
        if str(exc) == "unsafe_auto_link":
            # Same recovery path as the OIDC callback: the login page
            # renders the collision modal off these query params.
            return await _fail(
                str(exc), error_code="unsafe_auto_link", email=identity.email,
            )
        return await _fail(f"sso_login_rejected:{exc}")

    response = RedirectResponse(next_path, status_code=status.HTTP_302_FOUND)
    set_session_cookies(response, tokens)
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    logger.info("Custom profile login succeeded (slug=%s, user=%s, source=%s)",
                slug, user.id, source)
    return response


@router.post("/{slug}/browser-profile", response_model=SessionResponse,
             response_model_by_alias=True)
@limiter.limit("10/minute")
async def custom_profile_browser_login(
    slug: str,
    request: Request,
    response: Response,
    body: _BrowserProfileBody,
):
    """Complete a custom-profile login from a payload the browser read
    out of local/sessionStorage.

    This is a fetch rather than a redirect because only JS can reach web
    storage; the session cookies ride back on the response and the
    caller navigates itself.

    Rejected unless the row is a ``custom_profile`` whose source really
    is browser storage — otherwise this endpoint would let a client hand
    us a payload for a cookie- or header-sourced provider, bypassing the
    channel the operator chose.
    """
    provider = await _resolve_provider(slug, request=request)
    if not isinstance(provider, CustomProfileProvider):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Not a custom profile provider",
        )
    if provider.settings.source not in BROWSER_STORAGE_SOURCES:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Provider does not read its profile from browser storage",
        )
    snap = await _provider_snapshot(slug)

    try:
        identity = provider.fetch_identity(body.payload)
    except CustomProfileError as exc:
        # The precise reason is audited, not returned — a caller poking
        # at this endpoint shouldn't learn why their payload failed.
        logger.info("Custom profile login failed (slug=%s): %s", slug, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "profile_rejected"},
        )

    try:
        user, tokens = await _complete_custom_profile(
            request, identity=identity, provider=provider, snap=snap,
        )
    except SSOAuthError as exc:
        logger.info("Custom profile login rejected (slug=%s): %s", slug, exc)
        detail: dict = {"error": str(exc)}
        if str(exc) == "unsafe_auto_link":
            detail["email"] = identity.email
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=detail,
        )

    set_session_cookies(response, tokens)
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    logger.info("Custom profile login succeeded (slug=%s, user=%s, source=%s)",
                slug, user.id, provider.settings.source)
    return SessionResponse(user=user)
