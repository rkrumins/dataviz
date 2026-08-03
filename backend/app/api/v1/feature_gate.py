"""One gate, any flag — the server-side half of an admin feature toggle.

A flag that only hides a button is a lie: the endpoint is still there, and anyone who knows the
URL still has the feature. Every user-facing toggle therefore needs BOTH halves — the UI hides
it (so nobody is offered something that will fail) and the server refuses it (so the toggle
actually means something). This module is the second half, and it exists so that adding the
next flag is one line rather than a new bespoke gate.

FAIL-OPEN vs FAIL-CLOSED — the one decision that matters here
-------------------------------------------------------------
A CAPABILITY flag (`versioningEnabled`, `traceEnabled`, `editModeEnabled`) defaults to ENABLED.
If the definition is missing or the flag row cannot be read, users must keep their product: a
database hiccup must never silently black out whole feature areas.

A SECURITY flag is the exact opposite. `signupEnabled` decides whether a stranger may create an
account. If we cannot determine its value we must assume the ADMIN'S INTENT WAS TO KEEP THE DOOR
SHUT, because the cost of guessing wrong is unbounded in one direction and merely annoying in
the other. Hence `default=False` at that call site — and it is not a detail, it is the whole
posture.
"""
from __future__ import annotations

import logging
from typing import Callable

from fastapi import Depends, HTTPException, Request

from backend.app.auth.dependencies import get_permission_claims
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.config.features_seed import REFUSAL_MESSAGES, option_ids
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims

logger = logging.getLogger(__name__)

_MUTATING = frozenset({"POST", "PATCH", "PUT", "DELETE"})

#: The global claims that mean "platform admin". `system:admin` implies every permission in
#: every scope; `system:org-admin` implies every workspace-scoped one. Both are administrators
#: for the purpose of a flag that asks "may a NON-admin do this?".
_ADMIN_CLAIMS = ("system:admin", "system:org-admin")

def feature_disabled(key: str) -> HTTPException:
    """The typed 403 every gate raises. `main.py` maps `FeatureDisabledError` the same way, so
    a service-layer refusal and a route-layer refusal look identical to the client."""
    return HTTPException(
        status_code=403,
        detail={
            "type": "feature_disabled",
            "feature": key,
            "message": REFUSAL_MESSAGES.get(
                key, f"The '{key}' feature is turned off for this deployment."
            ),
        },
    )


def require_feature(key: str, *, default: bool | None = None) -> Callable:
    """Per-route dependency: 403 `feature_disabled` when `key` is off.

    `default` is what we assume when the flag cannot be resolved — see the module docstring. It
    now comes from the flag's declared POSTURE in `config/feature_wiring.py` (capability →
    fail-open, security → fail-closed), so two gates on the same flag cannot disagree about
    which way it fails. Pass it explicitly only to override that, and say why.
    """
    fallback = fail_safe_default(key) if default is None else default

    async def _dep() -> None:
        if not await feature_flags.is_enabled_self_session(key, default=fallback):
            raise feature_disabled(key)
    return _dep


def require_admin_unless(key: str) -> Callable:
    """Per-route dependency for a flag that WIDENS access rather than switching a feature on.

    `semanticLayerNonAdminEditing` doesn't ask "is this feature available?" — the feature is
    always available to admins. It asks "may someone who ISN'T an admin do this?". So the gate
    is conditional on who is asking, and `require_feature` (which refuses everyone equally) is
    the wrong shape: it would lock admins out of their own product.

    Fails closed by construction: the flag's posture is `security`, so an unreadable flag means
    admins-only — the narrower world, which is the one an admin who cannot be consulted would
    have wanted.
    """
    async def _dep(claims: PermissionClaims = Depends(get_permission_claims)) -> None:
        if await feature_flags.is_enabled_self_session(key, default=fail_safe_default(key)):
            return
        if any(c in claims.global_perms for c in _ADMIN_CLAIMS):
            return
        raise feature_disabled(key)
    return _dep


async def ensure_view_mode_allowed(view_type: str | None, session) -> None:
    """`allowedViewModes` is a LIST, not a switch — so it can't be a `require_feature` gate.

    It answers "which layouts may a NEW view be built in?". Called from view create/update; a
    view already built in a since-withdrawn layout keeps working, because withdrawing a layout
    from new work is not the same as deleting the work already done in it.

    Fails open, like every capability flag: if the value isn't a usable list we cannot say which
    layouts are allowed, and refusing all of them would black out view creation entirely. An
    EMPTY list never reaches us — `validate_and_merge_values` refuses to save one ("At least one
    option must be selected"), so "empty" and "unreadable" are the same state here.

    And it only judges the layouts it GOVERNS (`option_ids`). `views.view_type` is free text; a
    type this flag never enumerated is not "disallowed", it is out of scope — see option_ids().
    """
    if not view_type or view_type not in option_ids("allowedViewModes"):
        return
    allowed = await feature_flags.get_value("allowedViewModes", session, default=None)
    if not isinstance(allowed, list) or not allowed:
        return
    if view_type not in allowed:
        logger.info("view type %r blocked by allowedViewModes=%s", view_type, allowed)
        raise feature_disabled("allowedViewModes")


async def resolve_enterprise_view_policy(session) -> str:
    """How open publishing may be on this deployment: the ceiling.

    ``enterpriseViewPolicy`` is a single-select, not a switch, so it
    cannot be a ``require_feature`` gate — the middle setting ("always
    require approval") is neither on nor off. Callers pass the result
    into ``view_access.resolve_publish_gate``, which owns the ladder.

    Fails OPEN to "workspaces decide", like every capability flag: if
    the value cannot be read we must not silently freeze publishing
    across the whole platform. The failure a person would report is
    "sharing stopped working", with nothing pointing at a database
    hiccup as the cause.
    """
    value = await feature_flags.get_value("enterpriseViewPolicy", session, default=None)
    return value if value in option_ids("enterpriseViewPolicy") else "workspaces"


def write_gate(key: str, *, default: bool = True, allow_suffixes: tuple[str, ...] = ()) -> Callable:
    """Router-level dependency: gate every MUTATING method on a router, leave GETs open.

    Reads stay open on purpose. Turning a feature off makes it unavailable, not invisible: an
    existing canvas must still render, an admin must still be able to inspect, and a script must
    still be able to export. What must stop is CHANGING things. `allow_suffixes` keeps specific
    mutating ops usable anyway (health/maintenance routes that keep already-created data alive).

    Gating at the router means the next write endpoint someone adds is gated by DEFAULT, rather
    than gated if they remember — which, over time, is the only version that stays true.
    """
    async def _dep(request: Request) -> None:
        if request.method not in _MUTATING:
            return
        path = request.url.path
        if any(path.endswith(s) for s in allow_suffixes):
            return
        if not await feature_flags.is_enabled_self_session(key, default=default):
            logger.info("write blocked by feature flag %s: %s %s", key, request.method, path)
            raise feature_disabled(key)
    return _dep
