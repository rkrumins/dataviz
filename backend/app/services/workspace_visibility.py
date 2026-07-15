"""Resource visibility for workspace-bound users (RBAC Phase 18).

Computes the set of ontology / provider / catalog-item ids a caller can
read based on their workspace bindings. The list endpoints on those
routers use these helpers to filter results so a workspace_viewer sees
only what their workspaces touch — never the full catalogue.

Returns ``None`` for the unrestricted case (super_admin / org_admin):
the caller's handler should treat ``None`` as "no filter, return
everything".

The visibility rules (per user's product call):

* **Ontologies** — visible if referenced by any data source in any
  workspace the user holds ``workspace:ontology:read`` in. Ontologies
  have no per-row ACL; their workspace association is via
  ``workspace_data_sources.ontology_id``.
* **Providers** — visible if referenced by any data source in any
  workspace the user is bound to, *or* if the provider's
  ``permitted_workspaces`` ACL overlaps any of the user's workspaces.
* **Catalog items** — same union shape as providers, via
  ``permitted_workspaces`` and ``workspace_data_sources.catalog_item_id``.

The ``permitted_workspaces`` column is JSON-encoded (text). ``["*"]``
means "every workspace can use this row" — those rows are visible to
any workspace-bound user.
"""
from __future__ import annotations

import json
import logging
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    CatalogItemORM,
    ProviderORM,
    WorkspaceDataSourceORM,
)
from backend.app.services.permission_service import PermissionClaims


logger = logging.getLogger(__name__)


def _is_unrestricted(claims: PermissionClaims) -> bool:
    """``None`` filter when the caller is a platform-tier admin."""
    return (
        "system:admin" in claims.global_perms
        or "system:org-admin" in claims.global_perms
    )


def _user_workspace_ids(claims: PermissionClaims) -> set[str]:
    return set(claims.ws_perms.keys())


def _parse_permitted(raw: Optional[str]) -> list[str]:
    """Defensive JSON parse for the ``permitted_workspaces`` column.
    Empty/malformed values mean "no overrides" — return an empty list."""
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(value, list):
        return []
    return [str(x) for x in value]


def _permitted_overlaps(
    permitted: Iterable[str],
    user_ws_ids: set[str],
) -> bool:
    """Wildcard ``*`` covers any user-bound workspace; otherwise the
    sets must intersect."""
    for entry in permitted:
        if entry == "*" or entry in user_ws_ids:
            return True
    return False


# ── Ontologies ──────────────────────────────────────────────────────

async def compute_visible_ontology_ids(
    session: AsyncSession,
    claims: PermissionClaims,
) -> Optional[set[str]]:
    """Set of ontology ids visible to ``claims``. ``None`` means
    unrestricted — caller should not filter."""
    if _is_unrestricted(claims):
        return None
    user_ws_ids = _user_workspace_ids(claims)
    if not user_ws_ids:
        return set()
    # Tombstoned data sources must not keep granting visibility: without the
    # deleted_at filter a deleted source still projects its ontology/provider/
    # catalog item into the caller's readable set (RBAC leak).
    stmt = (
        select(WorkspaceDataSourceORM.ontology_id)
        .where(WorkspaceDataSourceORM.workspace_id.in_(user_ws_ids))
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        .where(WorkspaceDataSourceORM.ontology_id.is_not(None))
        .distinct()
    )
    result = await session.execute(stmt)
    return {row[0] for row in result.all() if row[0] is not None}


# ── Providers ──────────────────────────────────────────────────────

async def compute_visible_provider_ids(
    session: AsyncSession,
    claims: PermissionClaims,
) -> Optional[set[str]]:
    """Set of provider ids visible to ``claims``. ``None`` = unrestricted."""
    if _is_unrestricted(claims):
        return None
    user_ws_ids = _user_workspace_ids(claims)
    if not user_ws_ids:
        return set()
    # Two contributors: providers referenced by the user's data sources,
    # and providers whose ``permitted_workspaces`` overlaps the user's
    # workspaces (per-row ACL). Both unioned.
    via_data_sources_stmt = (
        select(WorkspaceDataSourceORM.provider_id)
        .where(WorkspaceDataSourceORM.workspace_id.in_(user_ws_ids))
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        .distinct()
    )
    visible: set[str] = {
        row[0] for row in (await session.execute(via_data_sources_stmt)).all()
        if row[0] is not None
    }

    # permitted_workspaces is JSON text; filtering server-side via
    # LIKE would be fragile. The provider catalogue is small (operator-
    # registered), so a Python pass is cheap and correct.
    permitted_rows = await session.execute(
        select(ProviderORM.id, ProviderORM.permitted_workspaces)
    )
    for prov_id, permitted_raw in permitted_rows.all():
        if prov_id in visible:
            continue
        if _permitted_overlaps(_parse_permitted(permitted_raw), user_ws_ids):
            visible.add(prov_id)
    return visible


# ── Catalog items ──────────────────────────────────────────────────

async def ensure_ontology_visible(
    session: AsyncSession,
    claims: PermissionClaims,
    ontology_id: str,
    *,
    not_found_detail: Optional[str] = None,
) -> None:
    """Raise 404 if ``ontology_id`` is not visible to the caller.

    Caller must have already checked the read/manage permission. The
    404 (vs 403) is deliberate — we don't leak the existence of
    ontologies the caller can't see."""
    from fastapi import HTTPException
    visible = await compute_visible_ontology_ids(session, claims)
    if visible is None:
        return
    if ontology_id not in visible:
        raise HTTPException(
            status_code=404,
            detail=not_found_detail or f"Ontology '{ontology_id}' not found",
        )


async def compute_visible_catalog_ids(
    session: AsyncSession,
    claims: PermissionClaims,
) -> Optional[set[str]]:
    """Set of catalog-item ids visible to ``claims``. ``None`` = unrestricted."""
    if _is_unrestricted(claims):
        return None
    user_ws_ids = _user_workspace_ids(claims)
    if not user_ws_ids:
        return set()
    via_data_sources_stmt = (
        select(WorkspaceDataSourceORM.catalog_item_id)
        .where(WorkspaceDataSourceORM.workspace_id.in_(user_ws_ids))
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        .where(WorkspaceDataSourceORM.catalog_item_id.is_not(None))
        .distinct()
    )
    visible: set[str] = {
        row[0] for row in (await session.execute(via_data_sources_stmt)).all()
        if row[0] is not None
    }

    permitted_rows = await session.execute(
        select(CatalogItemORM.id, CatalogItemORM.permitted_workspaces)
    )
    for item_id, permitted_raw in permitted_rows.all():
        if item_id in visible:
            continue
        if _permitted_overlaps(_parse_permitted(permitted_raw), user_ws_ids):
            visible.add(item_id)
    return visible
