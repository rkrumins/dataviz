"""Admin feature gate for the versioning surface (``versioningEnabled`` flag).

Two flavours:

* ``versioning_write_gate`` — mounted as a ROUTER-LEVEL dependency on the whole
  ``/{ws_id}/versioning`` router (see ``api.py``). It blocks every mutating method
  (POST/PATCH/PUT/DELETE) when the flag is off, so new write endpoints are gated by
  default, while all GETs stay open (reads keep working for read-only canvases,
  admin debugging and scripts). A small allowlist keeps the ops surfaces that
  maintain already-versioned data usable while the feature is hidden: projection
  rebuild/reconcile, exports (read-shaped, produces files) and a freeze (a safety stop).
* ``require_versioning_enabled`` — explicit per-route dependency for write routes
  that live on OTHER routers (e.g. ``/graph/bootstrap``, ``/graph/resync``).
* ``require_branch_scope`` — the view, layout and library routes that take a
  ``branchId`` call it whatever ``RBAC_ENFORCE_VIEWS`` says: the branch must be one
  of the view's own graph that the caller can read (404), and a write needs an open
  draft (409 branch_closed) the caller can edit (403); main is never written (409).

``sync_override_gate`` is unrelated to the flag: it lets only a workspace admin pass the
sync safety overrides (``force``, ``allowMassDelete``) on both sync routes. Nor is
``require_publish_for_main``: a versioned graph's main is written directly only by a person with
publish, or with an API key whose owner has it.

Both go through ``FeatureFlagService.is_enabled_self_session`` (cache-first, 30s
TTL — the hot read paths never pay a DB-pool checkout for this), defaulting to
**enabled** so a missing definition can never lock users out.
"""
import logging
from typing import NamedTuple, Optional

from fastapi import Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    assert_session_alive_or_503,
    get_current_user,
    get_permission_claims,
)
from backend.app.db.models import ViewORM
from backend.app.db.repositories import data_source_repo
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.versioning.errors import MainWriteForbidden, PublishRequired
from backend.app.services.versioning.service import Viewer

logger = logging.getLogger(__name__)

VERSIONING_FLAG = "versioningEnabled"

# Mutating routes on the versioning router that must stay usable when the feature
# is OFF (they maintain existing versioned data; they are already _MANAGE-gated):
#   projection/rebuild + projection/reconcile — projection health ops
#   exports — read-shaped (produces a file download)
#   lifecycle/freeze — a safety freeze must work while the feature is hidden (unfreeze stays gated)
_WRITE_ALLOWLIST_SUFFIXES = ("/projection/rebuild", "/projection/reconcile", "/exports",
                             "/lifecycle/freeze")

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


async def require_branch_scope(session: AsyncSession, svc, view: ViewORM, branch_id: Optional[str], *,
                               actor: str, claims: PermissionClaims, write: bool) -> None:
    """Gate a view route's ``branchId`` (see module doc); a no-op without one. The literal
    ``'main'`` (which ``graph.py`` accepts too) reads the published view. The caller is the key's
    owner under an API key, and ``claims`` are narrowed to the key, as in ``viewer_ctx``."""
    if not branch_id:
        return
    # Lazy: this module is imported by api.py, before the versioning router.
    from backend.app.api.v1.endpoints.versioning import _domain_errors

    with _domain_errors():
        if branch_id == "main":
            if write:
                raise MainWriteForbidden()
            return
        ds_id = view.data_source_id
        if ds_id is None:
            primary = await data_source_repo.get_primary_data_source(session, view.workspace_id)
            ds_id = primary.id if primary else None
        viewer = Viewer(actor=actor, can_manage=has_permission(
            claims, "workspace:datasource:manage", workspace_id=view.workspace_id))
        await svc.check_view_branch(data_source_id=ds_id, branch_id=branch_id, viewer=viewer, write=write)


def require_publish_for_main(claims: PermissionClaims, ws_id: str) -> None:
    """403 ``publish_required`` when a person without ``workspace:datasource:publish`` writes a
    versioned graph's main directly: the graph routes with no draft, and bulk ingest. No API key can
    hold publish, so a key passes only where the person who owns it holds it (``KeyScope``); an
    owner whose grants could not be read never got the key's claims (503 at authentication). A
    denial decided against a workspace map nothing could supply is a 503, as in ``requires()``."""
    key = claims.key_scope
    if key is not None:
        allowed = key.owner_publishes(ws_id)
    else:
        allowed = has_permission(claims, "workspace:datasource:publish", workspace_id=ws_id)
    if allowed:
        return
    if not claims.ws_available:
        raise HTTPException(status_code=503, detail="Authorization temporarily unavailable")
    raise PublishRequired()


class SyncOverrides(NamedTuple):
    force: bool
    allow_mass_delete: bool


async def sync_override_gate(
    request: Request,
    force: bool = Query(False, description="Workspace admin: sync even though people's edits "
                                           "on main are at risk (curation_at_risk)."),
    allowMassDelete: bool = Query(False, description="Workspace admin: sync even though it "
                                                     "deletes more than the limit "
                                                     "(mass_delete_blocked)."),
    user=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> SyncOverrides:
    """Only a workspace admin may override a sync safety check. ``workspace:admin`` is a
    fail-closed permission, so the session is probed first, and a denial decided against a
    workspace map nothing could supply is a 503, as in ``requires()``. API keys never hold
    ``workspace:admin``, so a key gets the 403."""
    overrides = SyncOverrides(force, allowMassDelete)
    if not (force or allowMassDelete):
        return overrides
    perm, ws_id = "workspace:admin", request.path_params["ws_id"]
    await assert_session_alive_or_503(claims, permission=perm, user_id=user.id)
    if has_permission(claims, perm, workspace_id=ws_id):
        return overrides
    if not claims.ws_available:
        raise HTTPException(status_code=503, detail="Authorization temporarily unavailable")
    raise HTTPException(status_code=403, detail={
        "type": "access_denied", "code": "needs_admin", "required": perm,
        "error": "missing_permission", "permission": perm,
        "scope": {"type": "workspace", "id": ws_id},
        "message": f"Missing permission: {perm} — only a workspace admin can override a sync "
                   "safety check.",
    })
