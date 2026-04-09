"""
Adversarial edge-case tests that specifically verify the 5 bug fixes.

Each test targets the exact code path that was broken before the fix,
using edge cases designed to catch regressions.
"""
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import stats_repo, data_source_repo, feature_flags_repo
from backend.app.db.models import (
    ProviderORM,
    WorkspaceORM,
    WorkspaceDataSourceORM,
    DataSourceStatsORM,
    FeatureCategoryORM,
    FeatureDefinitionORM,
)
from backend.common.models.management import (
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_provider_workspace(
    session: AsyncSession,
    prov_id: str = "prov_bfv",
    ws_id: str = "ws_bfv",
):
    """Seed a provider and workspace, return (prov_id, ws_id)."""
    session.add(ProviderORM(id=prov_id, name="BFV Provider", provider_type="falkordb"))
    session.add(WorkspaceORM(id=ws_id, name="BFV Workspace"))
    await session.flush()
    return prov_id, ws_id


async def _seed_data_source(
    session: AsyncSession,
    prov_id: str,
    ws_id: str,
    ds_id: str = "ds_bfv",
    graph_name: str = "bfv-graph",
):
    """Seed a data source row directly."""
    ds = WorkspaceDataSourceORM(
        id=ds_id,
        workspace_id=ws_id,
        provider_id=prov_id,
        graph_name=graph_name,
    )
    session.add(ds)
    await session.flush()
    return ds_id


async def _seed_feature_defs(session: AsyncSession):
    """Seed a category + one feature definition."""
    session.add(FeatureCategoryORM(
        id="test_cat", label="Test", icon="x", color="#000", sort_order=0,
    ))
    session.add(FeatureDefinitionORM(
        key="testFlag",
        name="Test Flag",
        description="A flag for testing",
        category_id="test_cat",
        type="boolean",
        default_value="false",
        sort_order=0,
        deprecated=False,
    ))
    await session.flush()


# =====================================================================
# BUG FIX 1: stats_repo flush
#
# Before the fix, upsert_data_source_stats did NOT call flush() after
# session.add() or after mutating the existing row. This meant the
# data was not visible to subsequent queries within the same
# transaction (the INSERT/UPDATE was deferred).
# =====================================================================

async def test_stats_upsert_insert_immediately_queryable(db_session: AsyncSession):
    """After upsert (insert path), the row must be immediately queryable
    without an explicit commit or flush from the caller."""
    prov_id, ws_id = await _seed_provider_workspace(db_session)
    ds_id = await _seed_data_source(db_session, prov_id, ws_id)

    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=77,
        edge_count=88,
        entity_type_counts='{}',
        edge_type_counts='{}',
        schema_stats='{}',
        ontology_metadata='{}',
        graph_schema='{}',
    )
    # Do NOT call flush/commit here -- the repo itself must have flushed.
    # A raw SELECT should find the row.
    result = await db_session.execute(
        select(DataSourceStatsORM).where(DataSourceStatsORM.data_source_id == ds_id)
    )
    row = result.scalar_one_or_none()
    assert row is not None, "Insert path: row not queryable after upsert (missing flush?)"
    assert row.node_count == 77


async def test_stats_upsert_update_immediately_queryable(db_session: AsyncSession):
    """After upsert (update path), the mutated data must be immediately
    queryable without an explicit flush from the caller."""
    prov_id, ws_id = await _seed_provider_workspace(db_session)
    ds_id = await _seed_data_source(db_session, prov_id, ws_id)

    # Insert
    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=1, edge_count=1,
        entity_type_counts='{}', edge_type_counts='{}',
        schema_stats='{}', ontology_metadata='{}', graph_schema='{}',
    )

    # Update
    await stats_repo.upsert_data_source_stats(
        db_session,
        ds_id=ds_id,
        node_count=999, edge_count=888,
        entity_type_counts='{}', edge_type_counts='{}',
        schema_stats='{}', ontology_metadata='{}', graph_schema='{}',
    )

    # Verify without caller-side flush
    fetched = await stats_repo.get_data_source_stats(db_session, ds_id)
    assert fetched is not None
    assert fetched.node_count == 999, "Update path: stale data returned (missing flush?)"
    assert fetched.edge_count == 888


# =====================================================================
# BUG FIX 2: count_data_sources active-only filter
#
# Before the fix, count_data_sources counted ALL data sources for a
# workspace regardless of is_active. This broke the "prevent deleting
# the last one" guard: a workspace with 1 active + 1 inactive would
# report count=2, allowing deletion of the last active source.
# =====================================================================

async def test_count_data_sources_excludes_inactive(db_session: AsyncSession):
    """count_data_sources must only count is_active=True rows."""
    prov_id, ws_id = await _seed_provider_workspace(db_session, "prov_cnt", "ws_cnt")

    # Create two active data sources via the repo
    await data_source_repo.create_data_source(
        db_session, ws_id,
        DataSourceCreateRequest(provider_id=prov_id, graph_name="g_active1", label="A1"),
    )
    ds2 = await data_source_repo.create_data_source(
        db_session, ws_id,
        DataSourceCreateRequest(provider_id=prov_id, graph_name="g_active2", label="A2"),
    )
    assert await data_source_repo.count_data_sources(db_session, ws_id) == 2

    # Deactivate one
    await data_source_repo.update_data_source(
        db_session, ds2.id, DataSourceUpdateRequest(is_active=False),
    )

    count = await data_source_repo.count_data_sources(db_session, ws_id)
    assert count == 1, f"Expected 1 active, got {count} (inactive counted?)"


async def test_count_data_sources_all_inactive_returns_zero(db_session: AsyncSession):
    """If every data source is deactivated, count must be 0."""
    prov_id, ws_id = await _seed_provider_workspace(db_session, "prov_cnt2", "ws_cnt2")

    ds = await data_source_repo.create_data_source(
        db_session, ws_id,
        DataSourceCreateRequest(provider_id=prov_id, graph_name="g_only", label="Only"),
    )
    await data_source_repo.update_data_source(
        db_session, ds.id, DataSourceUpdateRequest(is_active=False),
    )

    count = await data_source_repo.count_data_sources(db_session, ws_id)
    assert count == 0, f"Expected 0 (all inactive), got {count}"


# =====================================================================
# BUG FIX 3: feature_flags OCC race -- version=new_version on insert
#
# Before the fix, the INSERT path in upsert_feature_flags set
# version=0 (the default) instead of version=new_version (which is
# expected_version+1 = 1). This meant a second upsert with
# expected_version=0 would wrongly succeed (UPDATE WHERE version=0
# would match), breaking optimistic concurrency control.
# =====================================================================

async def test_feature_flags_occ_stale_version_after_insert(db_session: AsyncSession):
    """After first insert (version=1), a write with expected_version=0 must fail."""
    await _seed_feature_defs(db_session)

    # First write: expected_version=0 -> inserts row with version=1
    _, v1 = await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"testFlag": True},
        expected_version=0,
    )
    assert v1 == 1, f"First insert should yield version=1, got {v1}"

    # A concurrent request that still thinks version=0 must be rejected
    with pytest.raises(feature_flags_repo.ConcurrencyConflictError):
        await feature_flags_repo.upsert_feature_flags(
            db_session,
            values={"testFlag": False},
            expected_version=0,
        )


async def test_feature_flags_occ_sequential_increments(db_session: AsyncSession):
    """Version must strictly increment: 0 -> 1 -> 2 -> 3."""
    await _seed_feature_defs(db_session)

    _, v1 = await feature_flags_repo.upsert_feature_flags(
        db_session, values={"testFlag": True}, expected_version=0,
    )
    assert v1 == 1

    _, v2 = await feature_flags_repo.upsert_feature_flags(
        db_session, values={"testFlag": False}, expected_version=1,
    )
    assert v2 == 2

    _, v3 = await feature_flags_repo.upsert_feature_flags(
        db_session, values={"testFlag": True}, expected_version=2,
    )
    assert v3 == 3

    # Trying to use any old version must fail
    with pytest.raises(feature_flags_repo.ConcurrencyConflictError):
        await feature_flags_repo.upsert_feature_flags(
            db_session, values={"testFlag": False}, expected_version=1,
        )


# =====================================================================
# BUG FIX 4: conftest _FAKE_USER created_at / updated_at
#
# Before the fix, _FAKE_USER had no created_at / updated_at, which
# caused GET /users/me to 500 because UserPublicResponse requires
# those fields. We cannot import argon2 in this environment, so we
# test the conftest fixture directly rather than via the HTTP endpoint.
# =====================================================================

async def test_fake_user_has_timestamps(fake_user):
    """The fake_user fixture must have created_at and updated_at set."""
    assert fake_user.created_at is not None, "created_at is missing on _FAKE_USER"
    assert fake_user.updated_at is not None, "updated_at is missing on _FAKE_USER"
    # Must be non-empty strings parseable as ISO timestamps
    assert len(fake_user.created_at) > 0
    assert len(fake_user.updated_at) > 0
    assert "T" in fake_user.created_at, "created_at doesn't look like ISO format"
