"""
Internal service-to-service auth for the aggregation Control Plane (:8091).

The control plane exposes job trigger / cancel / delete / purge / settings
with no end-user auth — the viz-service is the authenticated edge and the
control plane is an internal service. Before this, ANYTHING that could reach
:8091 (a compromised pod, a NetworkPolicy misconfig, lateral movement) could
drive it. This adds a shared-secret bearer token so only in-cluster callers
holding ``AGGREGATION_INTERNAL_TOKEN`` are accepted.

Enforcement:
- Token SET (the deployed state — compose + k8s Secret): every route except
  the exempt set requires ``Authorization: Bearer <token>``.
- Token UNSET in prod: the control plane refuses to start. "Never the
  deployed state" was a warning in a log nobody reads, and the failure it
  describes is an entire unauthenticated admin surface.
- Token UNSET elsewhere: auth is disabled with a loud startup warning. A
  dev-only convenience.

This is defense-in-depth *behind* NetworkPolicies, not a replacement for them.
The server (controlplane.py) and every client (viz-service proxy, insights
post-purge trigger, system-status probe) share this module so the header name
and token source never drift apart.
"""
import hmac
import logging
import os
from typing import Optional

from fastapi import Header, HTTPException, Request, status

logger = logging.getLogger(__name__)

INTERNAL_TOKEN_ENV = "AGGREGATION_INTERNAL_TOKEN"

# Paths that must stay open regardless of the token: the liveness/readiness
# probe (k8s cannot attach a bearer token) and the read-only API schema
# (harmless — the actions it documents are still gated).
_EXEMPT_PATHS = frozenset({"/health", "/docs", "/redoc", "/openapi.json"})


def get_internal_token() -> Optional[str]:
    """The configured shared secret, or None when auth is disabled."""
    token = os.getenv(INTERNAL_TOKEN_ENV, "").strip()
    return token or None


def internal_auth_headers() -> dict:
    """Headers a client attaches to reach the control plane. Empty dict when
    no token is configured (dev), so callers stay unconditional."""
    token = get_internal_token()
    return {"Authorization": f"Bearer {token}"} if token else {}


def assert_auth_mode_allowed() -> None:
    """Announce the enforcement state at control-plane startup, and refuse
    to start unauthenticated in production.

    Fails closed for the same reason ``require_encryption_or_plaintext_ok``
    does: an unset token does not degrade the control plane, it removes its
    only authentication. Every trigger / cancel / delete / purge / settings
    route on :8091 is then open to anything that can reach the port. That
    was already documented as "never the deployed state" — as a log line,
    which is not a control.
    """
    if get_internal_token():
        logger.info(
            "Control Plane internal auth ENABLED — bearer token required on "
            "all routes except %s", sorted(_EXEMPT_PATHS),
        )
        return

    message = (
        f"Control Plane internal auth is DISABLED: {INTERNAL_TOKEN_ENV} is "
        "unset, so every :8091 route — job trigger, cancel, delete, purge "
        "and settings — is open to anything that can reach the port."
    )
    if os.getenv("ENV", "dev").strip().lower() in ("prod", "production"):
        raise RuntimeError(
            message + f" Set {INTERNAL_TOKEN_ENV} (k8s Secret / compose) "
            "before deploying."
        )
    logger.warning("%s This is a dev-only mode.", message)



async def require_internal_token(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> None:
    """FastAPI dependency enforcing the shared-secret bearer token on every
    route except the exempt set. No-op when no token is configured."""
    if request.url.path in _EXEMPT_PATHS:
        return
    expected = get_internal_token()
    if expected is None:
        return  # auth disabled (dev) — warned at startup
    provided = ""
    if authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer "):].strip()
    # Constant-time compare so a wrong token can't be recovered by timing.
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal service token.",
        )
