"""
Tests for backend.app.db.repositories.catalog_repo.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import catalog_repo
from backend.app.db.models import ProviderORM, CatalogItemORM
from backend.common.models.management import (
    CatalogItemCreateRequest,
    CatalogItemUpdateRequest,
    CatalogItemResponse,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_provider(session: AsyncSession, name: str = "test-provider") -> ProviderORM:
    prov = ProviderORM(
        name=name,
        provider_type="mock",
    )
    session.add(prov)
    await session.flush()
    return prov


def _make_create_req(provider_id: str, **overrides) -> CatalogItemCreateRequest:
    defaults = dict(
        provider_id=provider_id,
        name="Test Catalog Item",
        source_identifier="graph_alpha",
        description="A test catalog item",
        permitted_workspaces=["*"],
    )
    defaults.update(overrides)
    return CatalogItemCreateRequest(**defaults)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_create_catalog_item(db_session: AsyncSession):
    prov = await _create_provider(db_session)
    req = _make_create_req(prov.id)
    resp = await catalog_repo.create_catalog_item(db_session, req)

    assert isinstance(resp, CatalogItemResponse)
    assert resp.name == "Test Catalog Item"
    assert resp.provider_id == prov.id
    assert resp.source_identifier == "graph_alpha"
    assert resp.status == "active"


async def test_get_catalog_item(db_session: AsyncSession):
    prov = await _create_provider(db_session)
    created = await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id)
    )
    fetched = await catalog_repo.get_catalog_item(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_catalog_item_missing(db_session: AsyncSession):
    result = await catalog_repo.get_catalog_item(db_session, "nonexistent")
    assert result is None


async def test_list_catalog_items_all(db_session: AsyncSession):
    prov = await _create_provider(db_session)
    await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id, name="Item A", source_identifier="g1")
    )
    await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id, name="Item B", source_identifier="g2")
    )
    results = await catalog_repo.list_catalog_items(db_session)
    assert len(results) == 2


async def test_list_catalog_items_with_provider_filter(db_session: AsyncSession):
    prov_a = await _create_provider(db_session, name="Provider A")
    prov_b = await _create_provider(db_session, name="Provider B")

    await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov_a.id, name="A Item", source_identifier="ga")
    )
    await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov_b.id, name="B Item", source_identifier="gb")
    )

    results_a = await catalog_repo.list_catalog_items(db_session, provider_id=prov_a.id)
    assert len(results_a) == 1
    assert results_a[0].name == "A Item"

    results_b = await catalog_repo.list_catalog_items(db_session, provider_id=prov_b.id)
    assert len(results_b) == 1
    assert results_b[0].name == "B Item"


async def test_update_catalog_item(db_session: AsyncSession):
    prov = await _create_provider(db_session)
    created = await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id)
    )
    update_req = CatalogItemUpdateRequest(
        name="Updated Name",
        description="Updated description",
        status="archived",
    )
    updated = await catalog_repo.update_catalog_item(
        db_session, created.id, update_req
    )
    assert updated is not None
    assert updated.name == "Updated Name"
    assert updated.description == "Updated description"
    assert updated.status == "archived"


async def test_update_catalog_item_missing(db_session: AsyncSession):
    update_req = CatalogItemUpdateRequest(name="Ghost")
    result = await catalog_repo.update_catalog_item(db_session, "nonexistent", update_req)
    assert result is None


async def test_delete_catalog_item(db_session: AsyncSession):
    prov = await _create_provider(db_session)
    created = await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id)
    )
    result = await catalog_repo.delete_catalog_item(db_session, created.id)
    assert result is True

    # Verify gone
    fetched = await catalog_repo.get_catalog_item(db_session, created.id)
    assert fetched is None


async def test_delete_catalog_item_missing(db_session: AsyncSession):
    result = await catalog_repo.delete_catalog_item(db_session, "nonexistent")
    assert result is False


async def test_idempotent_creation(db_session: AsyncSession):
    """Creating with same (provider_id, source_identifier) returns the existing row."""
    prov = await _create_provider(db_session)

    first = await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id, source_identifier="same_graph")
    )
    second = await catalog_repo.create_catalog_item(
        db_session, _make_create_req(prov.id, source_identifier="same_graph", name="Different Name")
    )

    assert first.id == second.id  # same row returned
    assert second.name == first.name  # original name preserved


async def test_cleanup_duplicate_catalog_items(db_session: AsyncSession):
    """cleanup_duplicate_catalog_items removes duplicates, keeping the earliest."""
    prov = await _create_provider(db_session)

    # Manually insert duplicates bypassing the idempotency check
    row1 = CatalogItemORM(
        provider_id=prov.id,
        source_identifier="dup_graph",
        name="First",
        status="active",
    )
    row2 = CatalogItemORM(
        provider_id=prov.id,
        source_identifier="dup_graph",
        name="Second (duplicate)",
        status="active",
    )
    db_session.add(row1)
    await db_session.flush()
    db_session.add(row2)
    await db_session.flush()

    # Verify both exist
    all_items = await catalog_repo.list_catalog_items(db_session, provider_id=prov.id)
    # list_catalog_items deduplicates in-memory, but both rows are in DB
    assert len(all_items) == 1  # deduplicated view

    deleted_count = await catalog_repo.cleanup_duplicate_catalog_items(db_session)
    assert deleted_count == 1

    # After cleanup, only one row remains in DB
    fetched = await catalog_repo.get_catalog_item(db_session, row1.id)
    assert fetched is not None
    assert fetched.name == "First"

    gone = await catalog_repo.get_catalog_item(db_session, row2.id)
    assert gone is None
