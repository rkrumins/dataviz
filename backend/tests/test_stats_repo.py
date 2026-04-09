"""
Unit tests for backend.app.db.repositories.stats_repo
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import stats_repo
from backend.app.db.models import (
    ProviderORM,
    WorkspaceORM,
    WorkspaceDataSourceORM,
    DataSourceStatsORM,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_data_source(session: AsyncSession, ds_id="ds_stat1") -> str:
    """Seed provider, workspace, and data source. Returns data source ID."""
    prov = ProviderORM(id="prov_stat1", name="Stats Provider", provider_type="falkordb")
    session.add(prov)
    ws = WorkspaceORM(id="ws_stat1", name="Stats Workspace")
    session.add(ws)
    await session.flush()
    ds = WorkspaceDataSourceORM(
        id=ds_id,
        workspace_id=ws.id,
        provider_id=prov.id,
        graph_name="stats-graph",
    )
    session.add(ds)
    await session.flush()
    return ds_id


# ── get (empty) ──────────────────────────────────────────────────────

async def test_get_data_source_stats_returns_none_when_empty(db_session: AsyncSession):
    result = await stats_repo.get_data_source_stats(db_session, "ds_nonexistent")
    assert result is None


# ── upsert (insert) ──────────────────────────────────────────────────

async def test_upsert_creates_new_stats(db_session: AsyncSession):
    ds_id = await _seed_data_source(db_session)

    result = await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=100,
        edge_count=200,
        entity_type_counts='{"Dataset": 50, "Table": 50}',
        edge_type_counts='{"CONTAINS": 200}',
        schema_stats='{"tables": 10}',
        ontology_metadata='{"version": 1}',
        graph_schema='{"nodes": ["Dataset"]}',
    )

    assert isinstance(result, DataSourceStatsORM)
    assert result.data_source_id == ds_id
    assert result.node_count == 100
    assert result.edge_count == 200
    assert result.entity_type_counts == '{"Dataset": 50, "Table": 50}'
    assert result.edge_type_counts == '{"CONTAINS": 200}'
    assert result.schema_stats == '{"tables": 10}'
    assert result.ontology_metadata == '{"version": 1}'
    assert result.graph_schema == '{"nodes": ["Dataset"]}'


# ── upsert (update) ─────────────────────────────────────────────────

async def test_upsert_updates_existing_stats(db_session: AsyncSession):
    ds_id = await _seed_data_source(db_session)

    # First insert
    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=10,
        edge_count=20,
        entity_type_counts='{}',
        edge_type_counts='{}',
        schema_stats='{}',
        ontology_metadata='{}',
        graph_schema='{}',
    )
    await db_session.flush()

    # Update
    updated = await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=500,
        edge_count=1000,
        entity_type_counts='{"Table": 500}',
        edge_type_counts='{"REFERENCES": 1000}',
        schema_stats='{"tables": 50}',
        ontology_metadata='{"version": 2}',
        graph_schema='{"nodes": ["Table"]}',
    )

    assert updated.node_count == 500
    assert updated.edge_count == 1000
    assert updated.entity_type_counts == '{"Table": 500}'
    assert updated.edge_type_counts == '{"REFERENCES": 1000}'
    assert updated.schema_stats == '{"tables": 50}'
    assert updated.ontology_metadata == '{"version": 2}'
    assert updated.graph_schema == '{"nodes": ["Table"]}'


# ── get after upsert ─────────────────────────────────────────────────

async def test_get_data_source_stats_after_upsert(db_session: AsyncSession):
    ds_id = await _seed_data_source(db_session)

    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=42,
        edge_count=84,
        entity_type_counts='{"X": 42}',
        edge_type_counts='{"Y": 84}',
        schema_stats='{}',
        ontology_metadata='{}',
        graph_schema='{}',
    )
    await db_session.flush()

    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert fetched is not None
    assert fetched.node_count == 42
    assert fetched.edge_count == 84


# ── upsert preserves data_source_id ─────────────────────────────────

async def test_upsert_does_not_create_duplicate(db_session: AsyncSession):
    """After two upserts, there should still be exactly one stats row."""
    ds_id = await _seed_data_source(db_session)

    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=1, edge_count=1,
        entity_type_counts='{}', edge_type_counts='{}',
        schema_stats='{}', ontology_metadata='{}', graph_schema='{}',
    )
    await db_session.flush()

    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=2, edge_count=2,
        entity_type_counts='{}', edge_type_counts='{}',
        schema_stats='{}', ontology_metadata='{}', graph_schema='{}',
    )
    await db_session.flush()

    # Verify only one row
    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert fetched is not None
    assert fetched.node_count == 2
