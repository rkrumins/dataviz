import json
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from backend.app.db.engine import Base
from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
from backend.app.ontology.models import ResolvedOntology
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import OntologyMetadata


class _StubProvider:
    def __init__(self, metadata: OntologyMetadata) -> None:
        self._metadata = metadata

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return self._metadata


class _StubOntologyService:
    def __init__(self, resolved: ResolvedOntology) -> None:
        self._resolved = resolved
        self.calls = 0
        self.last_entity_ids = None
        self.last_rel_ids = None

    async def resolve(self, workspace_id=None, data_source_id=None, introspected_entity_ids=None, introspected_rel_ids=None):
        self.calls += 1
        self.last_entity_ids = introspected_entity_ids
        self.last_rel_ids = introspected_rel_ids
        return self._resolved


@pytest.mark.asyncio
async def test_context_engine_uses_single_resolve_cache_and_projection():
    introspected = OntologyMetadata(
        containmentEdgeTypes=["CONTAINS"],
        lineageEdgeTypes=["FLOWS_TO"],
        edgeTypeMetadata={"FLOWS_TO": {"isContainment": False, "isLineage": True, "direction": "source-to-target", "category": "flow"}},
        entityTypeHierarchy={"domain": {"canContain": ["system"], "canBeContainedBy": []}},
        rootEntityTypes=["domain"],
    )
    resolved = ResolvedOntology(
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS_TO"],
        edge_type_metadata={"FLOWS_TO": {"isContainment": False, "isLineage": True, "direction": "source-to-target", "category": "flow"}},
        entity_type_hierarchy={"domain": {"canContain": ["system"], "canBeContainedBy": []}},
        root_entity_types=["domain"],
    )
    service = _StubOntologyService(resolved)
    engine = ContextEngine(provider=_StubProvider(introspected), ontology_service=service)
    engine._workspace_id = "ws_test"
    engine._data_source_id = "ds_test"

    flat_a = await engine.get_ontology_metadata()
    flat_b = await engine.get_ontology_metadata()
    resolved_cached = await engine._get_resolved_ontology()

    assert service.calls == 1
    assert flat_a.root_entity_types == ["domain"]
    assert flat_b.containment_edge_types == ["CONTAINS"]
    assert resolved_cached is resolved


@pytest.mark.asyncio
async def test_context_engine_extracts_introspection_ids_from_flat_metadata():
    introspected = OntologyMetadata(
        containmentEdgeTypes=["CONTAINS"],
        lineageEdgeTypes=["FLOWS_TO"],
        edgeTypeMetadata={
            "FLOWS_TO": {"isContainment": False, "isLineage": True, "direction": "source-to-target", "category": "flow"},
            "CONSUMES": {"isContainment": False, "isLineage": True, "direction": "source-to-target", "category": "flow"},
        },
        entityTypeHierarchy={
            "domain": {"canContain": ["system"], "canBeContainedBy": []},
            "system": {"canContain": [], "canBeContainedBy": ["domain"]},
        },
        rootEntityTypes=["domain"],
    )
    service = _StubOntologyService(ResolvedOntology())
    engine = ContextEngine(provider=_StubProvider(introspected), ontology_service=service)
    engine._workspace_id = "ws_test"

    await engine.get_ontology_metadata()

    assert sorted(service.last_entity_ids) == ["domain", "system"]
    assert sorted(service.last_rel_ids) == ["CONSUMES", "FLOWS_TO"]


@pytest.mark.asyncio
async def test_sqlalchemy_repo_prefers_primary_data_source_when_unspecified():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    # Aggregation models declare ``__table_args__ = ({"schema": "aggregation"},)``
    # for Postgres. Mirror the conftest fixture and attach an in-memory
    # database aliased as ``aggregation`` so create_all can place those
    # tables somewhere SQLite recognises.
    @event.listens_for(engine.sync_engine, "connect")
    def _attach_aggregation_schema(dbapi_conn, _connection_record):
        dbapi_conn.execute("ATTACH DATABASE ':memory:' AS aggregation")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        workspace = WorkspaceORM(id="ws1", name="Workspace")
        provider = ProviderORM(id="prov1", name="Provider", provider_type="falkordb")
        ont_primary = OntologyORM(id="ont_primary", name="Primary", version=1, entity_type_definitions=json.dumps({}), relationship_type_definitions=json.dumps({}))
        ont_other = OntologyORM(id="ont_other", name="Other", version=1, entity_type_definitions=json.dumps({}), relationship_type_definitions=json.dumps({}))
        session.add_all([workspace, provider, ont_primary, ont_other])
        session.add_all([
            WorkspaceDataSourceORM(id="ds_other", workspace_id="ws1", provider_id="prov1", ontology_id="ont_other", is_primary=False, created_at="2024-01-01T00:00:00Z"),
            WorkspaceDataSourceORM(id="ds_primary", workspace_id="ws1", provider_id="prov1", ontology_id="ont_primary", is_primary=True, created_at="2025-01-01T00:00:00Z"),
        ])
        await session.commit()

        repo = SQLAlchemyOntologyRepository(session)
        selected = await repo.get_for_data_source("ws1", None)
        assert selected is not None
        assert selected.id == "ont_primary"

    await engine.dispose()


def test_frontend_smoke_no_ontology_service_imports_and_selectors_exist():
    frontend_src = Path(__file__).resolve().parents[2] / "frontend" / "src"
    schema_store_file = frontend_src / "store" / "schema.ts"
    schema_store_text = schema_store_file.read_text(encoding="utf-8")

    assert "useEntityTypeHierarchyMap" in schema_store_text
    assert "useEdgeTypeMetadataMap" in schema_store_text

    legacy_import = "@/services/" + "ontologyService"
    for path in frontend_src.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        content = path.read_text(encoding="utf-8")
        assert legacy_import not in content
