"""The data source behind a view, described so another environment can find its twin.

Ids differ between environments; what stays the same when two environments onboard the same
source is its provider type, its graph name (or catalog source identifier), its identity
property, and its semantic layer's name. ``describe_source`` records exactly those, and
``target_suggestions`` (used by import) ranks a target environment's data sources against them.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    CatalogItemORM,
    OntologyORM,
    ProviderORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import data_source_repo

logger = logging.getLogger(__name__)


async def effective_data_source(session: AsyncSession, view: ViewORM) -> Optional[WorkspaceDataSourceORM]:
    """The view's data source, or its workspace's primary one when the view names none."""
    if view.data_source_id:
        return await data_source_repo.get_data_source_orm(session, view.data_source_id)
    return await data_source_repo.get_primary_data_source(session, view.workspace_id)


async def describe_source(
    session: AsyncSession,
    workspace_id: str,
    data_source: Optional[WorkspaceDataSourceORM],
    *,
    ontology_digest: Optional[str] = None,
) -> Dict[str, Any]:
    """A ``SourceDescriptor`` for the file. Each lookup is a keyed get, not a join: workspaces,
    providers and ontologies live in different ownership domains (see DOMAIN_OWNERSHIP.md)."""
    from backend.app.services.node_identity import load_node_identity

    workspace = await session.get(WorkspaceORM, workspace_id)
    descriptor: Dict[str, Any] = {
        "workspace": {"id": workspace_id, "name": workspace.name if workspace else None},
        "dataSource": {},
        "ontology": {"digest": ontology_digest} if ontology_digest else {},
    }
    if data_source is None:
        return descriptor

    provider = await session.get(ProviderORM, data_source.provider_id) if data_source.provider_id else None
    catalog = await session.get(CatalogItemORM, data_source.catalog_item_id) if data_source.catalog_item_id else None
    ontology = await session.get(OntologyORM, data_source.ontology_id) if data_source.ontology_id else None
    try:
        identity = (await load_node_identity(session, data_source)).identity_property
    except Exception:  # noqa: BLE001 — descriptive only; never fail an export over it
        identity = data_source.identity_property or "urn"
    descriptor["dataSource"] = {
        "id": data_source.id,
        "label": data_source.label,
        "providerType": provider.provider_type if provider else None,
        "graphName": data_source.graph_name,
        "catalogSourceIdentifier": catalog.source_identifier if catalog else None,
        "identityProperty": identity,
    }
    descriptor["ontology"] = {
        "name": ontology.name if ontology else None,
        "version": ontology.version if ontology else None,
        "digest": ontology_digest,
    }
    return descriptor


async def engine_for(session: AsyncSession, workspace_id: str, data_source_id: Optional[str]):
    """A context engine scoped to one data source: its ``provider`` is what identity lookups go
    through, and it resolves the ontology. Raises when the provider can't be reached."""
    from backend.app.providers.manager import provider_manager as provider_registry
    from backend.app.services.context_engine import ContextEngine

    return await ContextEngine.for_workspace(
        workspace_id, provider_registry, session, data_source_id=data_source_id,
    )
