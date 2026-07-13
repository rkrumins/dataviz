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

from fastapi import HTTPException, Request

from backend.app.services.feature_flags import feature_flags

logger = logging.getLogger(__name__)

_MUTATING = frozenset({"POST", "PATCH", "PUT", "DELETE"})

# What a user is TOLD when a flag stops them. The message must name the thing they were trying
# to do and who can restore it — "feature_disabled" alone tells a person nothing they can act on.
_MESSAGES: dict[str, str] = {
    "versioningEnabled":
        "Version control is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "traceEnabled":
        "Lineage tracing is turned off for this deployment. "
        "An administrator can enable it under Admin → Features.",
    "editModeEnabled":
        "Editing is turned off for this deployment, so views are read-only. "
        "An administrator can enable it under Admin → Features.",
    "signupEnabled":
        "Self-registration is turned off. Ask an administrator for an invitation.",
}


def feature_disabled(key: str) -> HTTPException:
    """The typed 403 every gate raises. `main.py` maps `FeatureDisabledError` the same way, so
    a service-layer refusal and a route-layer refusal look identical to the client."""
    return HTTPException(
        status_code=403,
        detail={
            "type": "feature_disabled",
            "feature": key,
            "message": _MESSAGES.get(key, f"The '{key}' feature is turned off for this deployment."),
        },
    )


def require_feature(key: str, *, default: bool = True) -> Callable:
    """Per-route dependency: 403 `feature_disabled` when `key` is off.

    `default` is what we assume when the flag cannot be resolved — see the module docstring.
    Capability flags pass `True` (keep the product working). Security flags pass `False`.
    """
    async def _dep() -> None:
        if not await feature_flags.is_enabled_self_session(key, default=default):
            raise feature_disabled(key)
    return _dep


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
