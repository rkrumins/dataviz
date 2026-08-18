"""
Repository for workspace_data_sources table.
Each data source binds a Provider + Graph Name + Blueprint within a Workspace.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import WorkspaceDataSourceORM
from backend.app.services.node_identity import load_node_identity
from backend.common.models.management import (
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    DataSourceResponse,
    redact_extra_config,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _effective(identity, attr: str, row, fallback: str) -> str:
    """Resolved value, or this row's own column when no resolution was passed."""
    if identity is not None:
        return getattr(identity, attr)
    return (getattr(row, attr, None) or fallback)


def _source(identity, attr: str, row, column: str) -> str:
    if identity is not None:
        return getattr(identity, attr)
    return "data_source" if getattr(row, column, None) else "default"


def _to_response(row: WorkspaceDataSourceORM, identity=None) -> DataSourceResponse:
    """Serialize a data source.

    ``identity`` is the row's mapping resolved across all four scopes
    (``backend.app.services.node_identity``). Callers that hold a session
    resolve it and pass it in; without it the response falls back to this row's
    own columns, which is correct for a source that overrides them and reports
    the platform default otherwise — the pre-scopes behaviour.
    """
    # Resolve display label: explicit label → catalog item name → graph_name → None
    resolved_label = row.label
    if not resolved_label and row.graph_name:
        resolved_label = row.graph_name
    if not resolved_label and hasattr(row, 'catalog_item') and row.catalog_item:
        resolved_label = row.catalog_item.name or row.catalog_item.source_identifier
    return DataSourceResponse(
        id=row.id,
        workspaceId=row.workspace_id,
        catalogItemId=row.catalog_item_id,
        ontologyId=row.ontology_id,
        label=resolved_label,
        isPrimary=bool(row.is_primary),
        isActive=bool(row.is_active),
        projectionMode=row.projection_mode,
        dedicatedGraphName=row.dedicated_graph_name,
        providerId=row.provider_id,
        graphName=row.graph_name,
        accessLevel=row.access_level,
        isRestricted=bool(getattr(row, 'is_restricted', False)),
        # extra_config is an UNENCRYPTED column and, like a provider's, can hold
        # secrets left over from before the request-boundary validator existed
        # (or a sibling field like the legacy redisUrl). Redact on the way out.
        extraConfig=redact_extra_config(json.loads(row.extra_config) if row.extra_config else None),
        # The RESOLVED mapping — never NULL, so clients never special-case the
        # default — plus which scope it came from.
        identityProperty=_effective(identity, "identity_property", row, "urn"),
        nameProperty=_effective(identity, "name_property", row, "name"),
        identityPropertySource=_source(identity, "identity_source", row, "identity_property"),
        namePropertySource=_source(identity, "name_source", row, "name_property"),
        sourceMode=row.source_mode,
        writeBackEnabled=bool(row.write_back_enabled),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

def _live():
    """THE liveness predicate. A soft-deleted data source is in the trash: it must never be
    listed, counted, resolved or polled.

    Deliberately NOT `is_active`. That flag is user-settable ("pause this source") and means
    something else entirely; making liveness depend on two columns staying in sync is how a
    tombstone eventually leaks back into a list. One predicate, one meaning.
    """
    return WorkspaceDataSourceORM.deleted_at.is_(None)


async def list_data_sources(
    session: AsyncSession, workspace_id: str
) -> List[DataSourceResponse]:
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id, _live())
        .order_by(WorkspaceDataSourceORM.created_at)
    )
    rows = list(result.scalars().all())
    # Resolve each row's mapping so the list reports what is actually in force.
    # The per-row cost is three keyed gets that all hit the session identity map
    # after the first source (one workspace, usually one provider) plus an
    # in-process-cached platform row — not N round-trips.
    return [_to_response(r, await load_node_identity(session, r)) for r in rows]


async def list_data_sources_for_workspaces(
    session: AsyncSession, workspace_ids: List[str]
) -> List[WorkspaceDataSourceORM]:
    """All data-source rows across a set of workspaces in one query —
    backs the bulk /datasources/cached-stats endpoint."""
    if not workspace_ids:
        return []
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id.in_(workspace_ids), _live())
        .order_by(WorkspaceDataSourceORM.created_at)
    )
    return list(result.scalars().all())


async def get_data_source(
    session: AsyncSession, ds_id: str
) -> Optional[DataSourceResponse]:
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.id == ds_id, _live())
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return _to_response(row, await load_node_identity(session, row))


async def get_data_source_orm(
    session: AsyncSession, ds_id: str, *, include_deleted: bool = False
) -> Optional[WorkspaceDataSourceORM]:
    """Return the raw ORM row (used by ProviderRegistry).

    `include_deleted` exists for the two callers that legitimately need a tombstone — restore,
    and the trash listing. Everything else gets None for a deleted source, which is what every
    caller's "not found" branch already handles correctly.
    """
    stmt = (select(WorkspaceDataSourceORM)
            .options(selectinload(WorkspaceDataSourceORM.catalog_item))
            .where(WorkspaceDataSourceORM.id == ds_id))
    if not include_deleted:
        stmt = stmt.where(_live())
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_primary_data_source(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceDataSourceORM]:
    """Return the primary data source for a workspace."""
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .options(selectinload(WorkspaceDataSourceORM.catalog_item))
        .where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.is_primary == True,  # noqa: E712
            WorkspaceDataSourceORM.is_active == True,
            _live(),          # a deleted primary must not keep serving the whole workspace
        )
    )
    row = result.scalar_one_or_none()
    if row:
        return row
    # Fallback: first active data source
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .options(selectinload(WorkspaceDataSourceORM.catalog_item))
        .where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.is_active == True,  # noqa: E712
            _live(),
        ).order_by(WorkspaceDataSourceORM.created_at)
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_data_source(
    session: AsyncSession,
    workspace_id: str,
    req: DataSourceCreateRequest,
    make_primary: bool = False,
) -> DataSourceResponse:
    if req.catalog_item_id:
        # Catalog-based: resolve provider and graph from the catalog entry
        from .catalog_repo import get_catalog_item_orm
        cat = await get_catalog_item_orm(session, req.catalog_item_id)
        if not cat:
            raise ValueError(f"Catalog Item '{req.catalog_item_id}' not found")

        # 1:1 constraint: a catalog item can only belong to one LIVE workspace. Without the
        # liveness filter, deleting a data source would make its catalog item un-re-addable for
        # the whole grace period — the undo window would quietly be a lockout window. (The DB
        # agrees: uq_ds_catalog_item_live is a partial unique index on the same predicate.)
        existing = await session.execute(
            select(WorkspaceDataSourceORM.workspace_id)
            .where(WorkspaceDataSourceORM.catalog_item_id == req.catalog_item_id, _live())
            .limit(1)
        )
        bound = existing.scalar_one_or_none()
        if bound:
            raise ValueError(
                f"Catalog item '{req.catalog_item_id}' is already allocated to workspace '{bound}'"
            )
        provider_id = cat.provider_id
        graph_name = cat.source_identifier
        label = req.label or cat.name or cat.source_identifier
    elif req.provider_id:
        # Direct provider+graph: used by bootstrap and direct API calls
        provider_id = req.provider_id
        graph_name = req.graph_name
        label = req.label or req.graph_name or "default"
    else:
        raise ValueError("DataSource requires either catalogItemId or providerId")

    row = WorkspaceDataSourceORM(
        workspace_id=workspace_id,
        catalog_item_id=req.catalog_item_id,
        provider_id=provider_id,
        graph_name=graph_name,
        ontology_id=req.ontology_id,
        label=label,
        is_primary=make_primary,
        is_active=True,
        extra_config=json.dumps(req.extra_config) if req.extra_config else None,
        # None → NULL, resolved to "urn" on read; only stored when the caller
        # onboards a graph whose identity property isn't the canonical urn.
        identity_property=(
            (req.identity_property.strip() or None)
            if req.identity_property else None
        ),
        name_property=(
            (req.name_property.strip() or None)
            if getattr(req, "name_property", None) else None
        ),
    )
    session.add(row)
    await session.flush()
    return _to_response(row, await load_node_identity(session, row))


async def update_data_source(
    session: AsyncSession,
    ds_id: str,
    req: DataSourceUpdateRequest,
) -> Optional[DataSourceResponse]:
    row = await get_data_source_orm(session, ds_id)
    if not row:
        return None

    if req.ontology_id is not None:
        # Allow clearing with empty string → None
        row.ontology_id = req.ontology_id if req.ontology_id else None
    if req.label is not None:
        row.label = req.label
    if req.is_active is not None:
        row.is_active = req.is_active
    if req.projection_mode is not None:
        # Allow clearing with empty string → None
        row.projection_mode = req.projection_mode if req.projection_mode else None
    if req.dedicated_graph_name is not None:
        row.dedicated_graph_name = req.dedicated_graph_name if req.dedicated_graph_name else None
    if getattr(req, "access_level", None) is not None:
        row.access_level = req.access_level
    if getattr(req, "is_restricted", None) is not None:
        row.is_restricted = req.is_restricted
    if req.extra_config is not None:
        row.extra_config = json.dumps(req.extra_config) if req.extra_config else None
    if req.identity_property is not None:
        # Editable across the whole lifecycle. Empty string clears to NULL —
        # "unset", which falls through to the provider, then the workspace, then
        # the platform default. Storing the literal "urn" instead (as this did
        # before the other scopes existed) would pin the source to the default
        # forever and make "clear this override" the one thing you could not do.
        row.identity_property = req.identity_property.strip() or None
    if getattr(req, "name_property", None) is not None:
        row.name_property = req.name_property.strip() or None

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row, await load_node_identity(session, row))


async def soft_delete_data_source(
    session: AsyncSession, ds_id: str, actor: Optional[str] = None
) -> bool:
    """Move a data source to the trash. Reversible; nothing is destroyed.

    This is what makes restore possible AT ALL, and the reason is worth stating: every child of
    a data source is wired `ON DELETE SET NULL` (`views.data_source_id`, `context_models`,
    `assignment_rule_sets`). A hard DELETE does not merely break those links — IT ERASES THEM.
    Afterwards no row anywhere remembers which views belonged to the source, so resurrecting the
    data-source row would resurrect an island. Because a soft delete issues no DB-level DELETE,
    SET NULL never fires, every child keeps pointing at the tombstone, and restore is one UPDATE.
    """
    row = await get_data_source_orm(session, ds_id)          # live rows only: re-delete is a no-op
    if row is None:
        return False
    row.deleted_at = datetime.now(timezone.utc).isoformat()
    row.deleted_by = actor
    await session.flush()
    return True


async def restore_data_source(
    session: AsyncSession, ds_id: str
) -> Optional[DataSourceResponse]:
    """Bring a data source back from the trash. Its views, models and stats come with it."""
    row = await get_data_source_orm(session, ds_id, include_deleted=True)
    if row is None or row.deleted_at is None:
        return None
    row.deleted_at = None
    row.deleted_by = None
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row, await load_node_identity(session, row))


async def list_deleted_data_sources(
    session: AsyncSession, workspace_id: str
) -> List[WorkspaceDataSourceORM]:
    """The trash, newest first."""
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id,
               WorkspaceDataSourceORM.deleted_at.isnot(None))
        .order_by(WorkspaceDataSourceORM.deleted_at.desc())
    )
    return list(result.scalars().all())


async def delete_data_source(
    session: AsyncSession, ds_id: str
) -> bool:
    """HARD delete. Only two callers may use this, and both mean it: the "delete permanently"
    path, and the reaper once the grace period has run out. Everything a user does goes through
    `soft_delete_data_source`."""
    result = await session.execute(
        delete(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.id == ds_id)
    )
    return result.rowcount > 0


async def count_data_sources(
    session: AsyncSession, workspace_id: str
) -> int:
    """Count live data sources for a workspace (used to prevent deleting the last one).

    The `deleted_at` filter is NOT optional here, and it is not redundant with `is_active`: a
    workspace holding one live source and one tombstone would otherwise count 2, and cheerfully
    let the user delete the last source they actually have.
    """
    from sqlalchemy import func
    result = await session.execute(
        select(func.count()).where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.is_active == True,  # noqa: E712
            _live(),
        )
    )
    return result.scalar() or 0

async def get_data_source_impact(session: AsyncSession, ds_id: str):
    """Return the set of views that would be affected by changing/deleting this data source."""
    from ..models import ContextModelORM, ViewORM
    from backend.common.models.management import WorkspaceDataSourceImpactResponse, ImpactedEntity

    # Query the views table (primary source of truth for new views)
    view_result = await session.execute(
        select(ViewORM.id, ViewORM.name, ViewORM.view_type)
        .where(ViewORM.data_source_id == ds_id)
    )
    views = [{"id": r[0], "name": r[1], "type": r[2] or "view"} for r in view_result.all()]

    # Also check legacy context_models for backward compatibility
    seen_ids = {v["id"] for v in views}
    cm_result = await session.execute(
        select(ContextModelORM.id, ContextModelORM.name)
        .where(ContextModelORM.data_source_id == ds_id)
    )
    for r in cm_result.all():
        if r[0] not in seen_ids:
            views.append({"id": r[0], "name": r[1], "type": "context_model"})

    # The VERSIONED half of the blast radius. Views can be rebuilt; commits, open drafts and
    # human curation cannot — and it is those that a confirmation dialog owes the user, alongside
    # the reassurance that their own FalkorDB graph is not going anywhere.
    #
    # (`_name_draft_owners` runs here, not in graphver: the versioning store has no idea who a
    # user is, and this is the layer that already holds a session that does.)
    #
    # Best-effort: if graphver is unreachable we still return the view impact rather than 500 the
    # dialog. A delete confirmation that fails to open is a delete confirmation nobody reads.
    versioning = None
    try:
        from backend.common.models.management import VersioningImpact
        from backend.app.services.versioning.lifecycle import versioning_impact
        ds_row = await get_data_source_orm(session, ds_id)
        if ds_row is not None:
            raw = await versioning_impact(ds_id, ds_row.workspace_id)
            if raw:
                raw["openDrafts"] = await _name_draft_owners(session, raw.get("openDrafts") or [])
                versioning = VersioningImpact(**raw)
    except Exception:                                    # pragma: no cover - best effort
        logger.exception("versioning impact unavailable for ds=%s", ds_id)

    from backend.app.services.versioning import config as gv_config
    return WorkspaceDataSourceImpactResponse(
        views=[ImpactedEntity(**v) for v in views],
        versioning=versioning,
        restoreWindowDays=gv_config.PURGE_GRACE_DAYS,
    )


async def _name_draft_owners(session: AsyncSession, drafts: list) -> list:
    """Turn `usr_cd8b62ea79b6` into `Priya Raman`.

    Drafts are overwhelmingly called "Untitled draft", so a list of draft NAMES tells the user
    nothing at all. The owner is the whole point: it is what turns "36 drafts will be deleted"
    from a statistic into a reason to go and ask someone first. An opaque user id does that job
    no better than the name did.
    """
    if not drafts:
        return drafts
    from backend.app.db.models import UserORM

    ids = {d.get("owner") for d in drafts if d.get("owner")}
    names: dict = {}
    if ids:
        rows = (await session.execute(
            select(UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email)
            .where(UserORM.id.in_(list(ids))))).all()
        for uid, first, last, email in rows:
            names[uid] = " ".join(p for p in (first, last) if p).strip() or email

    for d in drafts:
        # A user who has since been removed still leaves a draft behind. Say so plainly rather
        # than printing their id at someone.
        d["owner"] = names.get(d.get("owner"), "a former member")
    return drafts



async def set_primary(
    session: AsyncSession, workspace_id: str, ds_id: str
) -> bool:
    """Demote all data sources in workspace, then promote target."""
    await session.execute(
        update(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id)
        .values(is_primary=False)
    )
    result = await session.execute(
        update(WorkspaceDataSourceORM)
        .where(
            WorkspaceDataSourceORM.id == ds_id,
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            _live(),                # never promote something that is in the trash
        )
        .values(
            is_primary=True,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
    )
    return result.rowcount > 0
