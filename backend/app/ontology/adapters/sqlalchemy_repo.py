"""
SQLAlchemy implementation of OntologyRepositoryProtocol.

This adapter translates between the OntologyORM (DB model) and OntologyData
(domain model). All serialization/deserialization of JSON columns lives here.
"""
import json
import logging
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OntologyORM, WorkspaceDataSourceORM
from ..models import OntologyData

logger = logging.getLogger(__name__)


def _orm_to_data(row: OntologyORM) -> OntologyData:
    return OntologyData(
        id=row.id,
        name=row.name,
        version=row.version,
        entity_type_definitions=json.loads(row.entity_type_definitions or "{}"),
        relationship_type_definitions=json.loads(row.relationship_type_definitions or "{}"),
        containment_edge_types=json.loads(row.containment_edge_types or "[]"),
        lineage_edge_types=json.loads(row.lineage_edge_types or "[]"),
        edge_type_metadata=json.loads(row.edge_type_metadata or "{}"),
        entity_type_hierarchy=json.loads(row.entity_type_hierarchy or "{}"),
        root_entity_types=json.loads(row.root_entity_types or "[]"),
        is_system=bool(row.is_system) if row.is_system is not None else False,
        scope=row.scope or "universal",
    )


class SQLAlchemyOntologyRepository:
    """
    Concrete implementation of OntologyRepositoryProtocol backed by SQLAlchemy.
    Accepts an AsyncSession injected at construction or per-call.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_system_default(self) -> Optional[OntologyData]:
        result = await self._session.execute(
            select(OntologyORM)
            .where(OntologyORM.is_system == True)  # noqa: E712
            .order_by(OntologyORM.version.desc())
            .limit(1)
        )
        row = result.scalar_one_or_none()
        return _orm_to_data(row) if row else None

    async def get_by_id(self, ontology_id: str) -> Optional[OntologyData]:
        result = await self._session.execute(
            select(OntologyORM).where(OntologyORM.id == ontology_id)
        )
        row = result.scalar_one_or_none()
        return _orm_to_data(row) if row else None

    async def get_for_data_source(
        self,
        workspace_id: str,
        data_source_id: Optional[str] = None,
    ) -> Optional[OntologyData]:
        """
        Resolve the ontology assigned to a data source.
        Falls back to workspace-level (first data source in workspace) when
        data_source_id is None.
        """
        q = (
            select(OntologyORM)
            .join(
                WorkspaceDataSourceORM,
                WorkspaceDataSourceORM.ontology_id == OntologyORM.id,
            )
            .where(WorkspaceDataSourceORM.workspace_id == workspace_id)
        )
        if data_source_id:
            q = q.where(WorkspaceDataSourceORM.id == data_source_id)
        else:
            q = q.order_by(
                WorkspaceDataSourceORM.is_primary.desc(),
                WorkspaceDataSourceORM.created_at.asc(),
            )
        q = q.limit(1)
        result = await self._session.execute(q)
        row = result.scalar_one_or_none()
        return _orm_to_data(row) if row else None

    async def save(self, data: OntologyData) -> OntologyData:
        result = await self._session.execute(
            select(OntologyORM).where(OntologyORM.id == data.id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            row = OntologyORM(id=data.id)
            self._session.add(row)

        row.name = data.name
        row.version = data.version
        row.entity_type_definitions = json.dumps(data.entity_type_definitions)
        row.relationship_type_definitions = json.dumps(data.relationship_type_definitions)
        row.containment_edge_types = json.dumps(data.containment_edge_types)
        row.lineage_edge_types = json.dumps(data.lineage_edge_types)
        row.edge_type_metadata = json.dumps(data.edge_type_metadata)
        row.entity_type_hierarchy = json.dumps(data.entity_type_hierarchy)
        row.root_entity_types = json.dumps(data.root_entity_types)
        row.is_system = data.is_system
        row.scope = data.scope

        await self._session.flush()
        # Ensure schema_id is populated (mirrors create_ontology logic)
        if not row.schema_id:
            row.schema_id = row.id
            await self._session.flush()
        return _orm_to_data(row)

    async def list_all(self, latest_only: bool = True) -> List[OntologyData]:
        result = await self._session.execute(
            select(OntologyORM).order_by(OntologyORM.name, OntologyORM.version.desc())
        )
        rows = result.scalars().all()
        if not latest_only:
            return [_orm_to_data(r) for r in rows]
        # Return only the highest version per name
        seen: dict = {}
        out: List[OntologyData] = []
        for row in rows:
            if row.name not in seen:
                seen[row.name] = True
                out.append(_orm_to_data(row))
        return out
