"""
Unit tests for backend.app.db.repositories.feature_flags_repo
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import feature_flags_repo
from backend.app.db.models import (
    FeatureCategoryORM,
    FeatureDefinitionORM,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_definitions(session: AsyncSession):
    """Seed a category and two feature definitions for testing."""
    cat = FeatureCategoryORM(
        id="general",
        label="General",
        icon="settings",
        color="#000",
        sort_order=0,
    )
    session.add(cat)

    defn1 = FeatureDefinitionORM(
        key="editModeEnabled",
        name="Edit Mode",
        description="Toggle edit mode",
        category_id="general",
        type="boolean",
        default_value="false",
        sort_order=0,
        deprecated=False,
    )
    defn2 = FeatureDefinitionORM(
        key="darkTheme",
        name="Dark Theme",
        description="Enable dark theme",
        category_id="general",
        type="boolean",
        default_value="true",
        sort_order=1,
        deprecated=False,
    )
    defn3 = FeatureDefinitionORM(
        key="legacyFeature",
        name="Legacy Feature",
        description="Deprecated feature",
        category_id="general",
        type="boolean",
        default_value="false",
        sort_order=2,
        deprecated=True,
    )
    session.add_all([defn1, defn2, defn3])
    await session.flush()


# ── get_feature_flags (no row) ───────────────────────────────────────

async def test_get_feature_flags_returns_defaults_when_no_row(db_session: AsyncSession):
    await _seed_definitions(db_session)
    values, updated_at, version = await feature_flags_repo.get_feature_flags(db_session)

    # Should return defaults for non-deprecated definitions
    assert "editModeEnabled" in values
    assert "darkTheme" in values
    assert values["editModeEnabled"] is False
    assert values["darkTheme"] is True
    # Deprecated key should be excluded by default
    assert "legacyFeature" not in values
    assert updated_at is None
    assert version == 0


async def test_get_feature_flags_include_deprecated(db_session: AsyncSession):
    await _seed_definitions(db_session)
    values, _, _ = await feature_flags_repo.get_feature_flags(
        db_session, include_deprecated=True
    )

    assert "legacyFeature" in values
    assert values["legacyFeature"] is False


# ── upsert_feature_flags (first write) ───────────────────────────────

async def test_upsert_feature_flags_first_write(db_session: AsyncSession):
    await _seed_definitions(db_session)

    updated_at, version = await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": True, "darkTheme": False},
        expected_version=0,
    )

    assert updated_at is not None
    # First write creates row with version 1 (proper OCC)
    assert version == 1


async def test_get_feature_flags_after_upsert(db_session: AsyncSession):
    await _seed_definitions(db_session)

    await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": True, "darkTheme": False},
        expected_version=0,
    )

    values, updated_at, version = await feature_flags_repo.get_feature_flags(db_session)

    # Custom values should override defaults
    assert values["editModeEnabled"] is True
    assert values["darkTheme"] is False
    assert updated_at is not None


# ── upsert_feature_flags (subsequent write) ──────────────────────────

async def test_upsert_feature_flags_second_write(db_session: AsyncSession):
    await _seed_definitions(db_session)

    # First write (creates row with version=0)
    _, v0 = await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": True},
        expected_version=0,
    )
    # v0 is 0 (initial insert)

    # Second write: the row currently has version=v0, so expected_version=v0
    # The atomic UPDATE matches WHERE version=v0, then sets version=v0+1
    updated_at, v1 = await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": False},
        expected_version=v0,
    )

    assert updated_at is not None
    assert v1 == v0 + 1  # version should have incremented


# ── upsert_feature_flags (concurrency conflict) ─────────────────────

async def test_upsert_feature_flags_concurrency_conflict(db_session: AsyncSession):
    await _seed_definitions(db_session)

    # First write
    await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": True},
        expected_version=0,
    )

    # Attempt to write with stale version (0 instead of the current version)
    # The row already exists with version=0, but we expect version=999
    with pytest.raises(feature_flags_repo.ConcurrencyConflictError):
        await feature_flags_repo.upsert_feature_flags(
            db_session,
            values={"editModeEnabled": False},
            expected_version=999,
        )


# ── remove_keys_from_config ──────────────────────────────────────────

async def test_remove_keys_from_config(db_session: AsyncSession):
    await _seed_definitions(db_session)

    # Write some values
    await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": True, "darkTheme": False, "legacyFeature": True},
        expected_version=0,
    )

    result = await feature_flags_repo.remove_keys_from_config(
        db_session, {"legacyFeature"}
    )

    assert result is not None
    updated_at, new_version = result

    # Verify the key was removed
    values, _, _ = await feature_flags_repo.get_feature_flags(
        db_session, include_deprecated=True
    )
    # legacyFeature should revert to default since it was removed from config
    assert values["legacyFeature"] is False  # default value


async def test_remove_keys_from_config_no_change(db_session: AsyncSession):
    await _seed_definitions(db_session)

    await feature_flags_repo.upsert_feature_flags(
        db_session,
        values={"editModeEnabled": True},
        expected_version=0,
    )

    # Try to remove a key that doesn't exist in config
    result = await feature_flags_repo.remove_keys_from_config(
        db_session, {"nonexistent_key"}
    )

    # Should return the current state without incrementing version
    assert result is not None


async def test_remove_keys_from_config_empty_keys(db_session: AsyncSession):
    result = await feature_flags_repo.remove_keys_from_config(db_session, set())
    assert result is None


async def test_remove_keys_from_config_no_row(db_session: AsyncSession):
    result = await feature_flags_repo.remove_keys_from_config(
        db_session, {"some_key"}
    )
    assert result is None
