"""The data source behind a view, described so another environment can find its twin.

Ids differ between environments; what stays the same when two environments onboard the same
source is its provider type, its graph name (or catalog source identifier), its identity
property, and its semantic layer's name. ``describe_source`` records exactly those, and
``target_suggestions`` (used by import) ranks a target environment's data sources against them.
Within one environment the semantic layer's id does match, and ``ontology_match`` uses it.
"""
from __future__ import annotations

import hashlib
import json
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
        "id": ontology.id if ontology else None,
        "name": ontology.name if ontology else None,
        "version": ontology.version if ontology else None,
        "digest": ontology_digest,
        # ``digest`` covers the data source's gap-filled types, so it cannot say whether the
        # semantic layer itself changed: this one can (``ontology_match``).
        "definitionDigest": await definition_digest(session, ontology.id) if ontology else None,
    }
    return descriptor


async def definition_digest(session: AsyncSession, ontology_id: str) -> Optional[str]:
    """The digest ``ContextEngine.get_ontology_digest`` gives a data source bound to this ontology
    with nothing in its graph to gap-fill: the same canonical JSON of the resolved ontology's flat
    metadata, hashed the same way. ``None`` for an unknown ontology."""
    from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
    from backend.app.ontology.resolver import resolve_ontology

    data = await SQLAlchemyOntologyRepository(session).get_by_id(ontology_id)
    if data is None:
        return None
    meta = resolve_ontology(system_default=None, assigned=data).to_flat_metadata()
    canonical = json.dumps(meta.model_dump(by_alias=True), sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def ontology_match(
    session: AsyncSession, claims, sources: Dict[str, Any], environment: Optional[str],
) -> Dict[str, Dict[str, Any]]:
    """Per source a file describes, the semantic layer here that IS its own, when there is one.

    Only within the environment the file was made in (both environments named, and the same):
    ontology ids differ between environments, and a digest covers its data source's gap-filled
    types, so neither is ever matched across them. There, the source's ontology id must name an
    ontology that still exists and the caller can see; ``drift`` says it has changed since the
    file was made — its own digest (``definitionDigest``) differs; never the gap-filled ``digest``,
    which differs whenever the exporting graph held a type outside its ontology. Elsewhere
    ``exact`` is ``None`` and the importer matches by the data's types instead
    (``package.data.typeStats``)."""
    from backend.app.services.view_transfer.export import environment_id

    here = environment_id()
    same = bool(environment and here and environment == here)
    out: Dict[str, Dict[str, Any]] = {}
    for key, source in sources.items():
        ref = (source or {}).get("ontology") or {}
        exact, drift = None, False
        row = await session.get(OntologyORM, ref["id"]) if same and ref.get("id") else None
        if row is not None and row.deleted_at is None and await _visible(session, claims, row.id):
            exact = {"ontologyId": row.id, "name": row.name, "version": row.version}
            drift = (bool(ref.get("definitionDigest"))
                     and await definition_digest(session, row.id) != ref["definitionDigest"])
        out[key] = {"exact": exact, "drift": drift, "sameEnvironment": same}
    return out


async def _visible(session: AsyncSession, claims, ontology_id: str) -> bool:
    from fastapi import HTTPException

    from backend.app.services.workspace_visibility import ensure_ontology_visible

    try:
        await ensure_ontology_visible(session, claims, ontology_id)
    except HTTPException:
        return False
    return True


async def engine_for(session: AsyncSession, workspace_id: str, data_source_id: Optional[str], *,
                     branch_id: Optional[str] = None, actor: Optional[str] = None):
    """A context engine scoped to one data source: its ``provider`` is what identity lookups go
    through, and it resolves the ontology. With ``branch_id`` (a draft of a version-controlled
    source) it reads that draft: published data with the draft's changes on top. Raises when the
    provider can't be reached."""
    from backend.app.providers.manager import provider_manager as provider_registry
    from backend.app.services.context_engine import ContextEngine

    return await ContextEngine.for_workspace(
        workspace_id, provider_registry, session, data_source_id=data_source_id,
        branch_id=branch_id, actor=actor,
    )
