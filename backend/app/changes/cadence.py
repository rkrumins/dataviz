"""How often browsers check the change feed: an admin setting, served cheaply.

The manifest is the hottest read in the app (every browser calls it on this
interval), so the interval is never read per request. It is cached in the
process for ``_TTL_S``: a change made through this process applies at once,
and other processes pick it up within the TTL. Browsers learn it from the
manifest itself, so nobody has to reload.
"""
from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

DEFAULT_CHECK_SECONDS = 60
#: The floor keeps the fleet's request rate bounded however the setting is
#: changed: below this, browsers would ask faster than any surface needs.
MIN_CHECK_SECONDS = 15
#: The ceiling bounds how stale a surface can get when a push is lost.
#: Provider outages are rechecked every minute regardless (the frontend's
#: ``lib/outageRecheck.ts``), so this never slows noticing a recovery.
MAX_CHECK_SECONDS = 600

_TTL_S = 30.0
_cache: dict = {"value": None, "at": 0.0, "reading": False}


def clamp(seconds: int) -> int:
    return max(MIN_CHECK_SECONDS, min(MAX_CHECK_SECONDS, int(seconds)))


def invalidate_cache() -> None:
    """Re-read on this process's next manifest. Other processes are bounded
    by the TTL."""
    _cache["at"] = 0.0


async def check_interval_seconds() -> int:
    """Seconds a browser should wait before its next check.

    Never raises. A missing column (a deployment mid-migration) or an
    unreachable database answers the last value read, or the default, and
    that answer is cached too: otherwise, with the database down, every
    manifest would queue for a connection it cannot get.

    One read at a time per process. While it is in flight, other callers
    answer the same way rather than each opening a session: with the
    database slow, a burst of manifests would otherwise hold the pool that
    readiness checks and every other request need.
    """
    now = time.monotonic()
    cached = _cache["value"]
    if cached is not None and now - _cache["at"] < _TTL_S:
        return cached
    fallback = cached if cached is not None else DEFAULT_CHECK_SECONDS
    if _cache["reading"]:
        return fallback

    _cache["reading"] = True
    value = fallback
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.models import PlatformSettingsORM

        async with get_async_session() as session:
            row = await session.get(PlatformSettingsORM, 1)
        stored = getattr(row, "change_check_interval_secs", None)
        value = clamp(stored) if stored is not None else DEFAULT_CHECK_SECONDS
    except Exception as exc:  # noqa: BLE001 — a setting must never fail the manifest
        logger.warning("Live updates interval unreadable, using %ss: %s", value, exc)
    finally:
        _cache["reading"] = False

    _cache["value"] = value
    _cache["at"] = now
    return value
