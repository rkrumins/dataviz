"""Public read-only feature values — GET /api/v1/features/values (no auth).

The app shell bootstraps flags from this endpoint (frontend ``store/features.ts``);
it must expose ONLY the merged value map, never admin metadata (schema, categories,
hints). Also covers the seeded ``versioningEnabled`` default and cache busting on
admin PATCH.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.seed_feature_registry import (
    seed_feature_flags,
    seed_feature_registry,
)
from backend.app.services.feature_flags import feature_flags


@pytest.fixture(autouse=True)
def _fresh_flag_cache():
    """The module-level FeatureFlagService caches for 30s — isolate every test."""
    feature_flags.invalidate()
    yield
    feature_flags.invalidate()


async def test_values_endpoint_shape(test_client: AsyncClient):
    """200 with values/version/updatedAt and nothing admin-shaped."""
    resp = await test_client.get("/api/v1/features/values")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"values", "version", "updatedAt"}
    assert isinstance(body["values"], dict)
    # Never leak the admin payload shapes on the public route.
    assert "schema" not in body and "categories" not in body


async def test_values_includes_seeded_versioning_flag(
    test_client: AsyncClient, db_session: AsyncSession
):
    """The seeded registry defaults ``versioningEnabled`` to true and it is public."""
    await seed_feature_registry(db_session)
    await seed_feature_flags(db_session)
    await db_session.commit()
    feature_flags.invalidate()

    resp = await test_client.get("/api/v1/features/values")
    assert resp.status_code == 200
    values = resp.json()["values"]
    assert values.get("versioningEnabled") is True
    # Spot-check another seeded flag rides along (value map is the full registry).
    assert "announcementsEnabled" in values


async def test_admin_patch_reflected_in_public_values(
    test_client: AsyncClient, db_session: AsyncSession
):
    """Turning a flag off via the admin PATCH is visible on the public route
    immediately (the PATCH busts the service cache)."""
    await seed_feature_registry(db_session)
    await seed_feature_flags(db_session)
    await db_session.commit()
    feature_flags.invalidate()

    get_resp = await test_client.get("/api/v1/admin/features")
    version = get_resp.json()["version"]

    patch = await test_client.patch(
        "/api/v1/admin/features",
        json={"version": version, "versioningEnabled": False},
    )
    assert patch.status_code == 200

    resp = await test_client.get("/api/v1/features/values")
    assert resp.status_code == 200
    assert resp.json()["values"]["versioningEnabled"] is False
