"""
SQLAlchemy implementation of OntologyRepositoryProtocol.

This adapter translates between the OntologyORM (DB model) and OntologyData
(domain model). All serialization/deserialization of JSON columns lives here.
"""
import json
import logging
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import AsyncIterator, Callable, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OntologyORM, WorkspaceDataSourceORM
from ..models import OntologyData

logger = logging.getLogger(__name__)


# Type alias: an async context manager factory that opens (and closes) a
# SQLAlchemy AsyncSession on demand. ``backend/app/db/engine.py`` exposes
# several of these — ``get_jobs_session``, ``get_readonly_session``,
# ``with_short_session`` — all of which match this signature when called.
SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


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

    Two construction modes:

    1. **Bound to a single session** (the original mode):
       ``SQLAlchemyOntologyRepository(session)``. Every method uses
       that session directly. Suitable for short-lived per-request
       repos where the caller already owns the session lifecycle (the
       FastAPI ``Depends(get_db_session)`` pattern).

    2. **Bound to a session factory** (long-lived service mode):
       ``SQLAlchemyOntologyRepository(session_factory=get_jobs_session)``.
       Each method opens a fresh session via the factory and closes it
       when the call returns. Suitable for the lifespan-scoped
       ``LocalOntologyService`` injected into the aggregation worker —
       there is no per-request session to bind to.

    Without mode #2, constructing a long-lived ontology service was
    impossible: the prior code did ``SQLAlchemyOntologyRepository(None)``
    with a comment promising "session injected per-call" but never
    implemented the mechanism, producing
    ``AttributeError: 'NoneType' object has no attribute 'execute'`` on
    every aggregation lookup. This fix supplies the missing mechanism.
    """

    def __init__(
        self,
        session: Optional[AsyncSession] = None,
        *,
        session_factory: Optional[SessionFactory] = None,
    ) -> None:
        if session is None and session_factory is None:
            raise ValueError(
                "SQLAlchemyOntologyRepository requires either an AsyncSession "
                "or a session_factory; got neither."
            )
        self._session = session
        self._session_factory = session_factory

    @asynccontextmanager
    async def _scope(self) -> AsyncIterator[AsyncSession]:
        """Yield a usable session.

        - If we were constructed with a bound session, yield it directly
          and let the caller manage its lifecycle.
        - Otherwise call the factory to open a fresh one for this call.
        """
        if self._session is not None:
            yield self._session
            return
        assert self._session_factory is not None  # checked in __init__
        async with self._session_factory() as session:
            yield session

    async def get_system_default(self) -> Optional[OntologyData]:
        async with self._scope() as session:
            result = await session.execute(
                select(OntologyORM)
                .where(OntologyORM.is_system == True)  # noqa: E712
                .order_by(OntologyORM.version.desc())
                .limit(1)
            )
            row = result.scalar_one_or_none()
            return _orm_to_data(row) if row else None

    async def get_by_id(self, ontology_id: str) -> Optional[OntologyData]:
        async with self._scope() as session:
            result = await session.execute(
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
        async with self._scope() as session:
            result = await session.execute(q)
            row = result.scalar_one_or_none()
            return _orm_to_data(row) if row else None

    async def save(self, data: OntologyData) -> OntologyData:
        async with self._scope() as session:
            result = await session.execute(
                select(OntologyORM).where(OntologyORM.id == data.id)
            )
            row = result.scalar_one_or_none()
            if row is None:
                row = OntologyORM(id=data.id)
                session.add(row)

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

            await session.flush()
            return _orm_to_data(row)

    async def list_all(self, latest_only: bool = True) -> List[OntologyData]:
        async with self._scope() as session:
            result = await session.execute(
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
