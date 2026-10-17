"""Topic names for the change feed, and who is allowed to hear them.

A topic is a coarse label for "some resource a client is showing may
have moved". It carries no payload — only a version counter — so a
client learning that ``announcements`` changed learns nothing except
that it should re-read the endpoint it was already entitled to read.

**Topics are derived from the caller's identity, never accepted from
the caller.** That is the whole authorization story for this feature. A
client cannot ask for ``notif:someone-else`` because a client never
names a topic at all: it authenticates, and the server answers with the
set that identity implies. Where an endpoint offers a narrowing filter,
the filter is intersected with this set and can only ever shrink it.

Scoping is deliberately coarse. The alternative — per-workspace provider
topics — would put workspace ids in the topic namespace, make the
admin's topic set grow with the tenant, and buy very little: provider
state is bumped only on an actual transition, so the over-fetch it
avoids is a handful of requests a day. One global topic keeps the
authorization trivial and the topic set bounded, and the endpoints
behind it are permission-filtered server-side exactly as before.
"""
from __future__ import annotations

from typing import Iterable

__all__ = [
    "ANNOUNCEMENTS",
    "FEATURES",
    "PROVIDER_HEALTH",
    "PROVIDER_STATUS",
    "GLOBAL_TOPICS",
    "notifications_for",
    "permissions_for",
    "invite_activity_for",
    "topics_for_user",
    "narrow",
]


# ── Global topics — every authenticated client subscribes ─────────────

ANNOUNCEMENTS = "announcements"
"""Active announcement banners. Bumped on admin CRUD."""

FEATURES = "features"
"""Public feature-flag values. Bumped on an admin flag write — which
also gives the flag cache the cross-worker invalidation it never had:
``feature_flags.invalidate()`` only ever cleared the calling process's
copy, so the other workers served stale values until their own 30s TTL
expired."""

PROVIDER_HEALTH = "providers:health"
"""Aggregate provider health (``GET /api/v1/health/providers``)."""

PROVIDER_STATUS = "providers:status"
"""Per-provider connection status (``GET /api/v1/admin/providers/status``)."""

GLOBAL_TOPICS: tuple[str, ...] = (
    ANNOUNCEMENTS,
    FEATURES,
    PROVIDER_HEALTH,
    PROVIDER_STATUS,
)


# ── Per-user topics ───────────────────────────────────────────────────
#
# Keyed on user id, NOT session id. A session id is minted fresh on every
# token refresh (``permission_service.resolve`` defaults ``sid`` to a new
# value, and both login and refresh call it without one), so a publisher
# reacting to an RBAC change has no way to name the subscriber's current
# sid — a ``perms:{sid}`` topic could never be bumped correctly. The
# write side already thinks in users: ``revoke_all_user_sessions`` takes
# a user id, and role and group changes expand to a user set anyway.


def notifications_for(user_id: str) -> str:
    """The bell (``GET /api/v1/me/notifications``)."""
    return f"notif:{user_id}"


def permissions_for(user_id: str) -> str:
    """The caller's own claims (``GET /api/v1/me/permissions``)."""
    return f"perms:{user_id}"


def invite_activity_for(user_id: str) -> str:
    """Redemptions of the caller's invite links."""
    return f"invite:{user_id}"


def topics_for_user(user_id: str) -> tuple[str, ...]:
    """Every topic this user is entitled to hear about.

    The only input is the authenticated user id, taken from the session
    — never from a query parameter or request body.
    """
    return GLOBAL_TOPICS + (
        permissions_for(user_id),
        notifications_for(user_id),
        invite_activity_for(user_id),
    )


def narrow(allowed: Iterable[str], requested: Iterable[str] | None) -> tuple[str, ...]:
    """Intersect a client's requested topics with what it may hear.

    ``requested`` is a convenience for a client that only cares about a
    subset — it can shrink the answer and never widen it. An unknown or
    forbidden name simply is not in ``allowed`` and falls out here, with
    no error to distinguish "no such topic" from "not yours"; that is
    deliberate, since the difference is only useful to someone probing.
    """
    allowed_set = tuple(allowed)
    if requested is None:
        return allowed_set
    wanted = set(requested)
    return tuple(topic for topic in allowed_set if topic in wanted)
