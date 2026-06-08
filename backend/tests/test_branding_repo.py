"""Unit tests for backend.app.db.repositories.branding_repo.

Covers the env-default fallback (the seam that makes ``APP_BRAND_*``
the default and the DB row the override), optimistic-version
concurrency, and the logo data-URI resolution.
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import branding_repo
from backend.app.db.repositories.branding_repo import ConflictingVersion


# ── env-default fallback ──────────────────────────────────────────────

async def test_snapshot_falls_back_to_env_defaults_when_no_row(
    db_session: AsyncSession, monkeypatch,
):
    monkeypatch.setenv("APP_BRAND_NAME", "Acme Lineage")
    monkeypatch.setenv("APP_BRAND_ACCENT_COLOR", "#0ea5e9")
    snap = await branding_repo.get_snapshot(db_session)
    assert snap.app_name == "Acme Lineage"
    assert snap.accent_color == "#0ea5e9"
    # No row yet -> version 0 sentinel.
    assert snap.version == 0


async def test_null_column_falls_back_to_env_default(
    db_session: AsyncSession, monkeypatch,
):
    monkeypatch.setenv("APP_BRAND_DESCRIPTION", "Env description")
    # Create a row that sets the name but leaves description NULL.
    await branding_repo.update_config(
        db_session, app_name="DB Name", updated_by="admin_1",
    )
    snap = await branding_repo.get_snapshot(db_session)
    assert snap.app_name == "DB Name"            # DB value wins
    assert snap.description == "Env description"  # NULL -> env default


# ── update + optimistic concurrency ───────────────────────────────────

async def test_update_creates_row_and_bumps_version(db_session: AsyncSession):
    row = await branding_repo.update_config(
        db_session, app_name="First", updated_by="admin_1",
    )
    assert row.version == 2  # seeded inline at 1, bumped to 2
    assert row.app_name == "First"
    assert row.updated_by == "admin_1"


async def test_version_conflict_raises(db_session: AsyncSession):
    await branding_repo.update_config(db_session, app_name="v2")
    snap = await branding_repo.get_snapshot(db_session)
    with pytest.raises(ConflictingVersion):
        await branding_repo.update_config(
            db_session, app_name="stale",
            expected_version=snap.version + 99,
        )


async def test_matching_version_succeeds(db_session: AsyncSession):
    await branding_repo.update_config(db_session, app_name="v2")
    snap = await branding_repo.get_snapshot(db_session)
    row = await branding_repo.update_config(
        db_session, app_name="v3", expected_version=snap.version,
    )
    assert row.app_name == "v3"
    assert row.version == snap.version + 1


# ── reset ─────────────────────────────────────────────────────────────

async def test_reset_clears_overrides_to_env_defaults(
    db_session: AsyncSession, monkeypatch,
):
    monkeypatch.setenv("APP_BRAND_NAME", "Env Name")
    # Override several fields (including an uploaded logo)...
    await branding_repo.update_config(
        db_session, app_name="Custom", accent_color="#abcdef",
        logo_data="QUJD", logo_mime="image/png",
    )
    # ...then reset clears them so the snapshot resolves to env defaults.
    await branding_repo.reset_config(db_session, updated_by="admin_1")
    snap = await branding_repo.get_snapshot(db_session)
    assert snap.app_name == "Env Name"
    assert snap.logo_url == ""  # env default (no upload, no URL)


# ── logo / favicon resolution ─────────────────────────────────────────

async def test_uploaded_logo_resolves_to_data_uri(db_session: AsyncSession):
    await branding_repo.update_config(
        db_session, logo_data="QUJD", logo_mime="image/png",
    )
    snap = await branding_repo.get_snapshot(db_session)
    assert snap.logo_url == "data:image/png;base64,QUJD"


async def test_uploaded_logo_wins_over_url(db_session: AsyncSession):
    await branding_repo.update_config(
        db_session,
        logo_url="https://cdn.example.com/logo.svg",
        logo_data="QUJD", logo_mime="image/png",
    )
    snap = await branding_repo.get_snapshot(db_session)
    assert snap.logo_url.startswith("data:image/png;base64,")


async def test_logo_url_used_when_no_upload(db_session: AsyncSession):
    await branding_repo.update_config(
        db_session, logo_url="https://cdn.example.com/logo.svg",
    )
    snap = await branding_repo.get_snapshot(db_session)
    assert snap.logo_url == "https://cdn.example.com/logo.svg"
