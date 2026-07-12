"""Admin feature gate for the versioning surface (``versioningEnabled`` flag).

Two flavours:

* ``versioning_write_gate`` — mounted as a ROUTER-LEVEL dependency on the whole
  ``/{ws_id}/versioning`` router (see ``api.py``). It blocks every mutating method
  (POST/PATCH/PUT/DELETE) when the flag is off, so new write endpoints are gated by
  default, while all GETs stay open (reads keep working for read-only canvases,
  admin debugging and scripts). A small allowlist keeps the ops surfaces that
  maintain already-versioned data usable while the feature is hidden: projection
  rebuild/reconcile and exports (read-shaped, produces files).
* ``require_versioning_enabled`` — explicit per-route dependency for write routes
  that live on OTHER routers (e.g. ``/graph/bootstrap``, ``/graph/resync``).

Both go through ``FeatureFlagService.is_enabled_self_session`` (cache-first, 30s
TTL — the hot read paths never pay a DB-pool checkout for this), defaulting to
**enabled** so a missing definition can never lock users out.
"""
import logging

from fastapi import HTTPException, Request

from backend.app.services.feature_flags import feature_flags

logger = logging.getLogger(__name__)

VERSIONING_FLAG = "versioningEnabled"

# Mutating routes on the versioning router that must stay usable when the feature
# is OFF (they maintain existing versioned data; they are already _MANAGE-gated):
#   projection/rebuild + projection/reconcile — projection health ops
#   exports — read-shaped (produces a file download)
_WRITE_ALLOWLIST_SUFFIXES = ("/projection/rebuild", "/projection/reconcile", "/exports")

_MUTATING = frozenset({"POST", "PATCH", "PUT", "DELETE"})


def _disabled_error() -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={
            "type": "feature_disabled",
            "feature": VERSIONING_FLAG,
            "message": "Version control is turned off for this deployment. "
                       "An administrator can enable it under Admin → Features.",
        },
    )


async def require_versioning_enabled() -> None:
    """Per-route dependency: 403 ``feature_disabled`` when versioning is off."""
    if not await feature_flags.is_enabled_self_session(VERSIONING_FLAG, default=True):
        raise _disabled_error()


async def versioning_write_gate(request: Request) -> None:
    """Router-level dependency: gate every mutating versioning route (see module doc)."""
    if request.method not in _MUTATING:
        return
    path = request.url.path
    if any(path.endswith(suffix) for suffix in _WRITE_ALLOWLIST_SUFFIXES):
        return
    if not await feature_flags.is_enabled_self_session(VERSIONING_FLAG, default=True):
        logger.info("versioning write blocked by feature flag: %s %s", request.method, path)
        raise _disabled_error()
