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
import os
import secrets
from typing import Callable, Optional

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
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
from ..core.config import (
    AUTH_CUSTOM_PROVIDER_ENABLED,
    RATELIMIT_LOGIN_PER_ACCOUNT,
    RATELIMIT_LOGIN_PER_IP,
    RATELIMIT_REFRESH_PER_SESSION,
)
from ..core.tokens import (
    create_mock_identity_token,
    create_oidc_state_token,
    create_saml_state_token,
    decode_dryrun_token,
    decode_link_intent_token,
    decode_oidc_state_token,
    decode_refresh_token,
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
from ..ratelimit import get_account_limiter

# SAML import is best-effort; the registry will refuse to materialise
# a saml2 provider when ``SAML_AVAILABLE`` is False, so we just need
# the type for isinstance checks.
try:
    from ..providers.saml2 import SamlProvider  # type: ignore
except ImportError:  # pragma: no cover
    SamlProvider = None  # type: ignore

logger = logging.getLogger(__name__)

router = APIRouter()


def _refresh_family_key(request: Request) -> str:
    """Bucket /auth/refresh by rotation family rather than by IP.

    ``get_remote_address`` is the wrong granularity for this endpoint and
    was actively harmful. Behind a proxy it returns the ingress address,
    so every user in the deployment shared one bucket; anyone in a NAT'd
    office shared one anyway. Refreshes also cluster — everyone who
    signed in at 09:00 rotates together — so a synchronised herd hit a
    shared fixed window, got a 429, and the SPA read that as "session
    gone" and signed them out. Random logouts under load, none in
    testing.

    A ``fam`` claim is exactly one browser session, which is the thing
    this limit is actually meant to protect, and it is immune to both
    NAT and missing forwarding headers. Requests with no usable cookie
    fall back to the address — they cannot name a session, and that path
    is what a flood of cookie-less refreshes would take.
    """
    token = read_refresh_cookie(request)
    if token:
        try:
            return f"fam:{decode_refresh_token(token, verify_exp=False).family_id}"
        except pyjwt.InvalidTokenError:
            pass
    return get_remote_address(request)


# Storage is shared when a Redis URL is configured. slowapi defaults to
# per-process memory, and the API runs 4 gunicorn workers per container
# across N replicas, so "30/minute" silently meant somewhere between 30
# and 30xNx4 depending on which worker the load balancer picked. Failures
# are swallowed: a Redis outage must not become a site-wide lockout.
#
# The trailing ``or None`` is load-bearing. The production overlay sets
# ``REDIS_URL: ""`` and expects the Secret to supply the real value; if
# it doesn't, an empty string reaches here and ``or`` alone would pass
# ``storage_uri=""`` to the limiter rather than falling back to memory.
# An unset variable and one set to the empty string mean the same thing
# at this layer, so normalise both to None.
def _resolve_ratelimit_storage_uri() -> Optional[str]:
    """Pick the limiter's storage backend from the environment."""
    return os.getenv("RATELIMIT_STORAGE_URI") or os.getenv("REDIS_URL") or None


_RATELIMIT_STORAGE_URI = _resolve_ratelimit_storage_uri()

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=_RATELIMIT_STORAGE_URI,
    swallow_errors=True,
)


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

    e = html.escape
    action = str(outcome.get("action", "unknown"))
    verdict = {
        "sign_in_existing": ("Would sign in", "#059669",
                             "This person already has an account here and it "
                             "would be reused."),
        "provision_new": ("Would create a new account", "#2563eb",
                          "No account matches. One would be created from the "
                          "claims below."),
        "link_existing": ("Would link to an existing account", "#2563eb",
                          "An account with this email already exists. This "
                          "identity would be attached to it."),
        "rejected": ("Would be refused", "#dc2626",
                     "This sign-in would not be allowed to complete."),
    }.get(action, (action, "#6b7280", ""))
    headline, accent, explain = verdict

    rows: list[str] = []

    def row(label: str, value: object) -> None:
        if value in (None, "", [], {}):
            return
        if isinstance(value, (list, tuple)):
            value = ", ".join(str(v) for v in value)
        rows.append(
            f"<tr><th>{e(label)}</th><td>{e(str(value))}</td></tr>"
        )

    row("Signing in as", outcome.get("email"))
    row("Name", " ".join(filter(None, [
        str(outcome.get("first_name") or ""),
        str(outcome.get("last_name") or ""),
    ])).strip())
    row("Their ID at the IdP", outcome.get("external_id"))
    row("Email verified by IdP", "yes" if outcome.get("email_verified") else "no")
    row("Existing account", outcome.get("user_email"))
    row("Groups asserted", outcome.get("groups"))
    row("Linking policy", outcome.get("linking_policy"))

    if outcome.get("reason"):
        row("Refused because", outcome["reason"])
    for reason in outcome.get("deny_reasons") or []:
        row("→", reason)

    reconcile = outcome.get("reconcile") or {}
    for m in reconcile.get("matched") or []:
        target = m.get("role_name") or m.get("group_id") or "?"
        row(f"Group '{m.get('idp_group')}' grants", target)
    if reconcile.get("unmatched_groups"):
        row("Groups with no mapping", reconcile["unmatched_groups"])

    # The raw outcome stays available, folded away — an operator debugging
    # a claim-shape problem needs it, and everyone else does not.
    raw = e(json.dumps(outcome, indent=2, default=str))

    return Response(
        content=(
            "<!doctype html><meta charset=utf-8>"
            '<meta name=viewport content="width=device-width,initial-scale=1">'
            f"<title>Rehearsal: {e(slug)}</title>"
            "<style>"
            ":root{color-scheme:light dark}"
            "body{font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;"
            "max-width:44rem;margin:0 auto;padding:3rem 1.25rem;color:#18181b}"
            "@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}"
            "table{background:#18181b}th{color:#a1a1aa}"
            "details{background:#18181b}pre{color:#d4d4d8}}"
            ".badge{display:inline-block;padding:.25rem .7rem;border-radius:999px;"
            "font-size:.75rem;font-weight:600;letter-spacing:.04em;"
            "text-transform:uppercase;color:#fff;background:" + accent + "}"
            "h1{font-size:1.6rem;margin:.75rem 0 .35rem;letter-spacing:-.02em}"
            ".lede{color:#71717a;margin:0 0 1.75rem}"
            "table{width:100%;border-collapse:collapse;border-radius:.6rem;"
            "overflow:hidden;background:#fafafa}"
            "th,td{text-align:left;padding:.6rem .85rem;font-size:.875rem;"
            "border-bottom:1px solid rgba(128,128,128,.18)}"
            "th{font-weight:500;color:#52525b;width:42%}"
            "td{font-variant-numeric:tabular-nums}"
            "tr:last-child th,tr:last-child td{border-bottom:0}"
            ".safe{margin:1.75rem 0 0;padding:.85rem 1rem;border-radius:.6rem;"
            "background:rgba(5,150,105,.09);border:1px solid rgba(5,150,105,.3);"
            "font-size:.85rem}"
            "details{margin-top:1.25rem;font-size:.8rem;background:#fafafa;"
            "border-radius:.6rem;padding:.7rem .9rem}"
            "summary{cursor:pointer;color:#71717a}"
            "pre{overflow-x:auto;font-size:.75rem;line-height:1.5}"
            "</style>"
            f'<span class="badge">Rehearsal</span>'
            f"<h1>{e(headline)}</h1>"
            f'<p class="lede">{e(explain)} Provider <code>{e(slug)}</code>.</p>'
            + (f"<table>{''.join(rows)}</table>" if rows else "")
            + '<p class="safe"><strong>Nothing was written.</strong> No account '
              "was created or changed and no session was started — close this "
              "tab and you are still signed in as yourself.</p>"
            f"<details><summary>Full result</summary><pre>{raw}</pre></details>"
        ),
        media_type="text/html",
    )


async def _dry_run_or_none(
    request: Request, *, svc, snap, slug: str, identity,
    clear_flow: Optional[Callable[[Response], None]] = None,
    as_json: bool = False,
) -> Optional[Response]:
    """If this flow is a rehearsal, render the outcome and stop.

    Called by **every** flow immediately after it has a verified identity
    in hand — which is the half that actually breaks in production, and
    the half worth rehearsing. Returning ``None`` means "not a dry-run,
    carry on".

    This exists as one function rather than an inline block per flow
    because the inline version reached two of the four kinds. It was
    missing from ``custom_profile``: the kind this whole surface was
    built for, and the only one that can be ``unverified`` or
    ``asserted`` — so the one where rehearsing matters most, because
    nothing cryptographic is standing behind it.
    """
    if not _is_dryrun(request, provider_id=snap.id):
        return None
    outcome = await svc.preview_sso_login(
        identity, provider_id=snap.id, linking_policy=snap.linking_policy,
    )
    resp: Response = (
        JSONResponse({"dryRun": True, "outcome": outcome}) if as_json
        else _dryrun_response(slug, outcome)
    )
    if clear_flow is not None:
        clear_flow(resp)
    clear_dryrun_cookie(resp)
    return resp


def _sso_failure_handler(
    svc, *, slug: str, snap, log_label: str,
    clear_flow: Optional[Callable[[Response], None]] = None,
):
    """Build the ``_fail`` closure each redirect-based flow needs.

    The four flows had four copies of this differing only in a log prefix
    and which cookie they cleared. One copy means a change to how failures
    are recorded — the ref, the audit event, what the user is told —
    lands everywhere at once.
    """
    async def _fail(reason: str, *, error_code: Optional[str] = None,
                    email: Optional[str] = None) -> RedirectResponse:
        ref = _failure_ref()
        logger.info("%s failed (slug=%s, ref=%s): %s",
                    log_label, slug, ref, reason)
        await _record_sso_failure(
            svc, ref=ref, slug=slug, provider_id=snap.id, reason=reason,
        )
        resp = RedirectResponse(
            _failure_redirect(ref, error_code=error_code, email=email),
            status_code=status.HTTP_302_FOUND,
        )
        if clear_flow is not None:
            clear_flow(resp)
        return resp

    return _fail


async def _finish_sso_login(
    request: Request, *, svc, snap, slug: str, identity, next_path: str,
    fail, clear_flow: Optional[Callable[[Response], None]] = None,
) -> Response:
    """Everything between "we have a verified identity" and a response.

    Rehearse-or-continue, resolve the link intent, complete the login, and
    bounce to the post-login target with the session attached — or hand
    back the failure redirect *fail* builds.

    Every redirect-based flow (OIDC, SAML, custom, custom_profile) shares
    this verbatim. It used to be copy-pasted, which is precisely why the
    dry-run reached two of the four: adding a step here meant remembering
    four call sites. Now it means one.
    """
    rehearsal = await _dry_run_or_none(
        request, svc=svc, snap=snap, slug=slug, identity=identity,
        clear_flow=clear_flow,
    )
    if rehearsal is not None:
        return rehearsal

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
            # The login page renders its collision modal off these params.
            return await fail(str(exc), error_code="unsafe_auto_link",
                              email=identity.email)
        return await fail(f"sso_login_rejected:{exc}")

    logger.info("SSO login succeeded (kind=%s, slug=%s, user=%s)",
                snap.kind, slug, user.id)
    return _session_redirect(
        request, next_path=next_path, tokens=tokens, clear_flow=clear_flow,
    )


def _session_redirect(
    request: Request, *, next_path: str, tokens,
    clear_flow: Optional[Callable[[Response], None]] = None,
) -> RedirectResponse:
    """The success tail every redirect-based SSO flow shares: bounce to
    the post-login target with the session cookies attached, and clear the
    in-flight handshake and link-intent cookies."""
    response = RedirectResponse(
        _safe_next(next_path), status_code=status.HTTP_302_FOUND,
    )
    set_session_cookies(response, tokens)
    if clear_flow is not None:
        clear_flow(response)
    # Clear whenever a link-intent cookie was presented — matched or
    # rejected — so a stale/replayed cookie can't be reused.
    if read_link_intent_cookie(request) is not None:
        clear_link_intent_cookie(response)
    return response


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
@limiter.limit(RATELIMIT_LOGIN_PER_IP)
async def login(
    request: Request,
    response: Response,
    body: LoginBody,
):
    svc = _identity_service(request)

    # Per-account throttle. The per-IP limit above is a flood guard sized
    # so a whole office signing in at 09:00 never reaches it, which by
    # construction makes it useless against a password spray. This is the
    # control that stops one: it keys on the account under attack, so it
    # holds however many addresses the attempts arrive from.
    accounts = get_account_limiter()
    if not await accounts.check("login", body.email, RATELIMIT_LOGIN_PER_ACCOUNT):
        retry_after = await accounts.retry_after_seconds(
            "login", body.email, RATELIMIT_LOGIN_PER_ACCOUNT,
        )
        logger.warning("Login throttled for account (too many failures)")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed sign-in attempts. Try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )

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
        # Only failures accumulate, so someone who signs in correctly
        # twenty times a day is never throttled.
        await accounts.record("login", body.email, RATELIMIT_LOGIN_PER_ACCOUNT)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # A success clears the count: a user who mistyped twice and then got
    # it right starts clean rather than carrying failures into next time.
    await accounts.reset("login", body.email, RATELIMIT_LOGIN_PER_ACCOUNT)
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
@limiter.limit(RATELIMIT_REFRESH_PER_SESSION, key_func=_refresh_family_key)
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
@limiter.limit(RATELIMIT_LOGIN_PER_IP)
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

    _fail = _sso_failure_handler(
        svc, slug=slug, snap=snap, log_label="OIDC callback",
        clear_flow=clear_oidc_cookie,
    )

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

    return await _finish_sso_login(
        request, svc=svc, snap=snap, slug=slug, identity=identity,
        next_path=flow.get("next"), fail=_fail,
        clear_flow=clear_oidc_cookie,
    )


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

    _fail = _sso_failure_handler(
        svc, slug=slug, snap=snap, log_label="SAML ACS",
        clear_flow=clear_saml_cookie,
    )

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

    return await _finish_sso_login(
        request, svc=svc, snap=snap, slug=slug, identity=identity,
        next_path=flow.get("next"), fail=_fail,
        clear_flow=clear_saml_cookie,
    )


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

    _fail = _sso_failure_handler(
        svc, slug=slug, snap=snap, log_label="Custom IdP login",
        clear_flow=clear_mock_identity_cookie,
    )

    try:
        identity = provider.fetch_identity(raw)
    except CustomIdentityError as exc:
        return await _fail(f"envelope_invalid:{exc}")

    return await _finish_sso_login(
        request, svc=svc, snap=snap, slug=slug, identity=identity,
        next_path=next_path, fail=_fail,
        clear_flow=clear_mock_identity_cookie,
    )


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

    svc = _identity_service(request)
    _fail = _sso_failure_handler(
        svc, slug=slug, snap=snap, log_label="Custom profile login",
    )

    if not raw:
        return await _fail(f"payload_missing_from_{source}")

    try:
        identity = provider.fetch_identity(raw)
    except CustomProfileError as exc:
        return await _fail(f"payload_rejected:{exc}")

    # The degraded-trust audit is this kind's own step; everything after
    # it is the shared tail.
    await _audit_degraded_trust(
        svc, provider=provider, snap=snap, via=source,
    )
    return await _finish_sso_login(
        request, svc=svc, snap=snap, slug=slug, identity=identity,
        next_path=next_path, fail=_fail,
    )


@router.post("/{slug}/browser-profile", response_model=SessionResponse,
             response_model_by_alias=True)
@limiter.limit(RATELIMIT_LOGIN_PER_IP)
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

    # JSON rather than the HTML page the redirect flows get: this endpoint
    # is reached by fetch(), so a page would never be seen.
    rehearsal = await _dry_run_or_none(
        request, svc=_identity_service(request), snap=snap, slug=slug,
        identity=identity, as_json=True,
    )
    if rehearsal is not None:
        return rehearsal

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
