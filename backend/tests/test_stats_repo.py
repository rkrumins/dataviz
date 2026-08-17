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


# ── counts facet: the digest is derived, never supplied ───────────────

async def test_counts_write_always_stamps_a_digest_of_what_it_wrote(
    db_session: AsyncSession,
):
    """The sweep's tripwire compares this digest against the one it last
    evaluated, so a row that carries counts must carry THEIR digest.

    It used to be an optional argument, and three callers (live observe,
    Probe now, first-contact seeding) wrote changed counts without one — the
    row then described itself with the previous write's digest and the sweep
    read "nothing moved" for counts that had just moved.
    """
    from backend.app.services.aggregation.fingerprint import (
        counts_digest_from_counts,
    )

    ds_id = await _seed_data_source(db_session)

    await stats_repo.upsert_data_source_stats_counts(
        db_session,
        ds_id=ds_id,
        node_count=10, edge_count=3,
        entity_type_counts='{"Table": 10}',
        edge_type_counts='{"FLOWS_TO": 3}',
    )
    await db_session.flush()

    # Read the value out, not the row: the second write below mutates the
    # same identity-mapped object.
    first_digest = (
        await stats_repo.get_data_source_stats(db_session, ds_id)
    ).counts_digest
    assert first_digest == counts_digest_from_counts(
        {"Table": 10}, {"FLOWS_TO": 3},
    )

    # The update path is where the bug lived: fresh counts, stale digest.
    await stats_repo.upsert_data_source_stats_counts(
        db_session,
        ds_id=ds_id,
        node_count=11, edge_count=3,
        entity_type_counts='{"Table": 11}',
        edge_type_counts='{"FLOWS_TO": 3}',
    )
    await db_session.flush()

    moved = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert moved.counts_digest == counts_digest_from_counts(
        {"Table": 11}, {"FLOWS_TO": 3},
    )
    assert moved.counts_digest != first_digest


# ── touch_probe_stamp ─────────────────────────────────────────────────

async def test_touch_probe_stamp_updates_without_touching_counts(
    db_session: AsyncSession,
):
    """The unanswerable-probe stamp: last_probed_at moves, nothing else."""
    ds_id = await _seed_data_source(db_session)
    await stats_repo.upsert_data_source_stats_counts(
        db_session,
        ds_id=ds_id,
        node_count=7, edge_count=3,
        entity_type_counts='{"Table": 7}',
        edge_type_counts='{"FLOWS_TO": 3}',
    )
    before = await stats_repo.get_data_source_stats(db_session, ds_id)
    updated_at, digest = before.updated_at, before.counts_digest

    await stats_repo.touch_probe_stamp(db_session, ds_id)

    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert fetched.last_probed_at is not None
    assert fetched.node_count == 7
    assert fetched.updated_at == updated_at    # the poll clock is untouched
    assert fetched.counts_digest == digest     # the tripwire is untouched


async def test_touch_probe_stamp_noop_when_row_missing(db_session: AsyncSession):
    """UPDATE-only: fabricating a zero-count row here could read as a wiped
    overlay downstream."""
    await stats_repo.touch_probe_stamp(db_session, "ds_nonexistent")

    fetched = await stats_repo.get_data_source_stats(db_session, "ds_nonexistent")
    assert fetched is None


# ── set_top_level_nodes ───────────────────────────────────────────────

async def test_set_top_level_nodes_round_trip(db_session: AsyncSession):
    ds_id = await _seed_data_source(db_session)

    await stats_repo.upsert_data_source_stats_counts(
        db_session,
        ds_id=ds_id,
        node_count=5,
        edge_count=5,
        entity_type_counts='{}',
        edge_type_counts='{}',
    )
    await db_session.flush()

    payload = '{"v": 1, "nodes": []}'
    await stats_repo.set_top_level_nodes(db_session, ds_id, payload)

    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert fetched is not None
    assert fetched.top_level_nodes == payload
    assert fetched.top_level_updated_at is not None


async def test_set_top_level_nodes_noop_when_row_missing(db_session: AsyncSession):
    # No seeded row for this ds_id — should no-op, not raise or create.
    await stats_repo.set_top_level_nodes(db_session, "ds_nonexistent", '{"v": 1}')

    fetched = await stats_repo.get_data_source_stats(db_session, "ds_nonexistent")
    assert fetched is None


# ── touch_top_level_freshness ─────────────────────────────────────────

async def test_touch_top_level_freshness_advances_timestamp_preserves_payload(
    db_session: AsyncSession,
):
    ds_id = await _seed_data_source(db_session)
    await stats_repo.upsert_data_source_stats_counts(
        db_session,
        ds_id=ds_id,
        node_count=5,
        edge_count=5,
        entity_type_counts='{}',
        edge_type_counts='{}',
    )
    payload = '{"v": 1, "nodes": [1, 2, 3]}'
    await stats_repo.set_top_level_nodes(db_session, ds_id, payload)
    first_ts = (await stats_repo.get_data_source_stats(db_session, ds_id)).top_level_updated_at

    await stats_repo.touch_top_level_freshness(db_session, ds_id)

    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    # Freshness marker advanced; the payload bytes are NOT rewritten.
    assert fetched.top_level_nodes == payload
    assert fetched.top_level_updated_at is not None
    assert fetched.top_level_updated_at >= first_ts


async def test_touch_top_level_freshness_noop_when_row_missing(db_session: AsyncSession):
    # No seeded row for this ds_id — should no-op, not raise or create.
    await stats_repo.touch_top_level_freshness(db_session, "ds_nonexistent")

    fetched = await stats_repo.get_data_source_stats(db_session, "ds_nonexistent")
    assert fetched is None


# ── invalidate_schema_facet (ontology-change invalidation) ───────────

async def test_invalidate_schema_facet_resets_graph_schema_and_freshness(
    db_session: AsyncSession,
):
    ds_id = await _seed_data_source(db_session)
    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=100,
        edge_count=200,
        entity_type_counts='{"Table": 100}',
        edge_type_counts='{"HAS_COLUMN": 200}',
        schema_stats='{"tables": 10}',
        ontology_metadata='{"version": 1}',
        graph_schema='{"containmentEdgeTypes": ["HAS_COLUMN"]}',
    )
    # Precondition: a full deep row with a populated schema + freshness marker.
    seeded = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert seeded.graph_schema != "{}"
    assert seeded.schema_updated_at is not None

    await stats_repo.invalidate_schema_facet(db_session, ds_id)

    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    # graph_schema reset to the CacheMiss marker → next /cached-schema read
    # falls to build_synthetic_schema; schema_updated_at cleared → the
    # scheduler's deep-due check fires and rebuilds it in full.
    assert fetched.graph_schema == "{}"
    assert fetched.schema_updated_at is None
    # Counts facet is untouched.
    assert fetched.node_count == 100
    assert fetched.edge_count == 200
    assert fetched.entity_type_counts == '{"Table": 100}'
    assert fetched.schema_stats == '{"tables": 10}'


async def test_invalidate_schema_facet_noop_when_row_missing(db_session: AsyncSession):
    # No seeded row — must no-op, not raise or create a phantom row.
    await stats_repo.invalidate_schema_facet(db_session, "ds_nonexistent")

    fetched = await stats_repo.get_data_source_stats(db_session, "ds_nonexistent")
    assert fetched is None
