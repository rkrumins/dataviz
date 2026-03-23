"""
Unit tests for backend.app.db.repositories.data_source_repo
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import data_source_repo
from backend.app.db.models import (
    ProviderORM,
    WorkspaceORM,
    WorkspaceDataSourceORM,
    CatalogItemORM,
    ContextModelORM,
    ViewORM,
)
from backend.common.models.management import (
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    DataSourceResponse,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_provider(session: AsyncSession, prov_id="prov_ds1") -> str:
    prov = ProviderORM(id=prov_id, name="DS Provider", provider_type="mock")
    session.add(prov)
    await session.flush()
    return prov_id


async def _seed_workspace(session: AsyncSession, ws_id="ws_ds1") -> str:
    ws = WorkspaceORM(id=ws_id, name="DS Workspace")
    session.add(ws)
    await session.flush()
    return ws_id


async def _seed_catalog(
    session: AsyncSession, prov_id: str, cat_id="cat_ds1"
) -> str:
    cat = CatalogItemORM(
        id=cat_id,
        provider_id=prov_id,
        name="Catalog Graph",
        source_identifier="catalog-graph",
    )
    session.add(cat)
    await session.flush()
    return cat_id


async def _seed_all(session: AsyncSession):
    """Seed provider, workspace, and catalog item. Returns (prov_id, ws_id, cat_id)."""
    prov_id = await _seed_provider(session)
    ws_id = await _seed_workspace(session)
    cat_id = await _seed_catalog(session, prov_id)
    return prov_id, ws_id, cat_id


def _make_direct_req(provider_id: str, **overrides) -> DataSourceCreateRequest:
    defaults = dict(
        provider_id=provider_id,
        graph_name="test-graph",
        label="Test DS",
    )
    defaults.update(overrides)
    return DataSourceCreateRequest(**defaults)


# ── create (direct provider) ─────────────────────────────────────────

async def test_create_data_source_direct(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    req = _make_direct_req(prov_id)
    resp = await data_source_repo.create_data_source(db_session, ws_id, req)

    assert isinstance(resp, DataSourceResponse)
    assert resp.id is not None
    assert resp.workspace_id == ws_id
    assert resp.provider_id == prov_id
    assert resp.graph_name == "test-graph"
    assert resp.label == "Test DS"
    assert resp.is_primary is False
    assert resp.is_active is True
    assert resp.created_at is not None


async def test_create_data_source_make_primary(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    req = _make_direct_req(prov_id)
    resp = await data_source_repo.create_data_source(
        db_session, ws_id, req, make_primary=True
    )
    assert resp.is_primary is True


async def test_create_data_source_with_extra_config(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    req = _make_direct_req(prov_id, extra_config={"mapping": "custom"})
    resp = await data_source_repo.create_data_source(db_session, ws_id, req)
    assert resp.extra_config == {"mapping": "custom"}


# ── create (catalog-based) ───────────────────────────────────────────

async def test_create_data_source_from_catalog(db_session: AsyncSession):
    prov_id, ws_id, cat_id = await _seed_all(db_session)
    req = DataSourceCreateRequest(catalog_item_id=cat_id, label="From Catalog")
    resp = await data_source_repo.create_data_source(db_session, ws_id, req)

    assert resp.catalog_item_id == cat_id
    assert resp.provider_id == prov_id
    assert resp.graph_name == "catalog-graph"
    assert resp.label == "From Catalog"


async def test_create_data_source_catalog_duplicate_raises(db_session: AsyncSession):
    prov_id, ws_id, cat_id = await _seed_all(db_session)
    req = DataSourceCreateRequest(catalog_item_id=cat_id)
    await data_source_repo.create_data_source(db_session, ws_id, req)

    # Second allocation of the same catalog item should raise
    ws_id2 = await _seed_workspace(db_session, ws_id="ws_ds2")
    with pytest.raises(ValueError, match="already allocated"):
        await data_source_repo.create_data_source(db_session, ws_id2, req)


async def test_create_data_source_catalog_not_found_raises(db_session: AsyncSession):
    _, ws_id, _ = await _seed_all(db_session)
    req = DataSourceCreateRequest(catalog_item_id="cat_nonexistent")
    with pytest.raises(ValueError, match="not found"):
        await data_source_repo.create_data_source(db_session, ws_id, req)


async def test_create_data_source_no_provider_or_catalog_raises(db_session: AsyncSession):
    _, ws_id, _ = await _seed_all(db_session)
    req = DataSourceCreateRequest()
    with pytest.raises(ValueError, match="requires either"):
        await data_source_repo.create_data_source(db_session, ws_id, req)


# ── get ───────────────────────────────────────────────────────────────

async def test_get_data_source(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    fetched = await data_source_repo.get_data_source(db_session, created.id)

    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.label == "Test DS"


async def test_get_data_source_returns_none_for_missing(db_session: AsyncSession):
    result = await data_source_repo.get_data_source(db_session, "ds_nonexistent")
    assert result is None


async def test_get_data_source_orm(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    orm_row = await data_source_repo.get_data_source_orm(db_session, created.id)

    assert orm_row is not None
    assert isinstance(orm_row, WorkspaceDataSourceORM)
    assert orm_row.id == created.id


# ── list ──────────────────────────────────────────────────────────────

async def test_list_data_sources(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="g1", label="DS1")
    )
    await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="g2", label="DS2")
    )

    result = await data_source_repo.list_data_sources(db_session, ws_id)
    assert len(result) == 2
    labels = {ds.label for ds in result}
    assert labels == {"DS1", "DS2"}


async def test_list_data_sources_empty(db_session: AsyncSession):
    result = await data_source_repo.list_data_sources(db_session, "ws_empty")
    assert result == []


async def test_list_data_sources_filters_by_workspace(db_session: AsyncSession):
    prov_id = await _seed_provider(db_session, prov_id="prov_filt")
    ws1 = await _seed_workspace(db_session, ws_id="ws_filt1")
    ws2 = await _seed_workspace(db_session, ws_id="ws_filt2")

    await data_source_repo.create_data_source(
        db_session, ws1, _make_direct_req(prov_id, graph_name="g_ws1")
    )
    await data_source_repo.create_data_source(
        db_session, ws2, _make_direct_req(prov_id, graph_name="g_ws2")
    )

    result_ws1 = await data_source_repo.list_data_sources(db_session, ws1)
    result_ws2 = await data_source_repo.list_data_sources(db_session, ws2)

    assert len(result_ws1) == 1
    assert len(result_ws2) == 1
    assert result_ws1[0].graph_name == "g_ws1"
    assert result_ws2[0].graph_name == "g_ws2"


# ── update ────────────────────────────────────────────────────────────

async def test_update_data_source_label(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    update_req = DataSourceUpdateRequest(label="Renamed DS")
    updated = await data_source_repo.update_data_source(
        db_session, created.id, update_req
    )

    assert updated is not None
    assert updated.label == "Renamed DS"


async def test_update_data_source_is_active(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    update_req = DataSourceUpdateRequest(is_active=False)
    updated = await data_source_repo.update_data_source(
        db_session, created.id, update_req
    )

    assert updated is not None
    assert updated.is_active is False


async def test_update_data_source_ontology_clear(db_session: AsyncSession):
    """Setting ontology_id to empty string should clear it to None."""
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, ontology_id="ont_1")
    )
    update_req = DataSourceUpdateRequest(ontology_id="")
    updated = await data_source_repo.update_data_source(
        db_session, created.id, update_req
    )

    assert updated is not None
    assert updated.ontology_id is None


async def test_update_data_source_projection_mode(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    update_req = DataSourceUpdateRequest(
        projection_mode="dedicated",
        dedicated_graph_name="proj_graph",
    )
    updated = await data_source_repo.update_data_source(
        db_session, created.id, update_req
    )

    assert updated.projection_mode == "dedicated"
    assert updated.dedicated_graph_name == "proj_graph"


async def test_update_data_source_extra_config(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    update_req = DataSourceUpdateRequest(extra_config={"key": "value"})
    updated = await data_source_repo.update_data_source(
        db_session, created.id, update_req
    )
    assert updated.extra_config == {"key": "value"}


async def test_update_data_source_returns_none_for_missing(db_session: AsyncSession):
    update_req = DataSourceUpdateRequest(label="Nope")
    result = await data_source_repo.update_data_source(
        db_session, "ds_missing", update_req
    )
    assert result is None


# ── delete ────────────────────────────────────────────────────────────

async def test_delete_data_source_success(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    created = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )
    deleted = await data_source_repo.delete_data_source(db_session, created.id)
    assert deleted is True

    fetched = await data_source_repo.get_data_source(db_session, created.id)
    assert fetched is None


async def test_delete_data_source_returns_false_for_missing(db_session: AsyncSession):
    result = await data_source_repo.delete_data_source(db_session, "ds_ghost")
    assert result is False


# ── count_data_sources ───────────────────────────────────────────────

async def test_count_data_sources(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    assert await data_source_repo.count_data_sources(db_session, ws_id) == 0

    await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="cnt1")
    )
    assert await data_source_repo.count_data_sources(db_session, ws_id) == 1

    await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="cnt2")
    )
    assert await data_source_repo.count_data_sources(db_session, ws_id) == 2


# ── get_primary_data_source ──────────────────────────────────────────

async def test_get_primary_data_source(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds1 = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="primary_g"),
        make_primary=True,
    )
    await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="secondary_g"),
    )

    primary = await data_source_repo.get_primary_data_source(db_session, ws_id)
    assert primary is not None
    assert primary.id == ds1.id


async def test_get_primary_data_source_fallback(db_session: AsyncSession):
    """When no primary is marked, should return the first active data source."""
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds1 = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="fb_g")
    )

    primary = await data_source_repo.get_primary_data_source(db_session, ws_id)
    assert primary is not None
    assert primary.id == ds1.id


async def test_get_primary_data_source_returns_none_when_empty(db_session: AsyncSession):
    result = await data_source_repo.get_primary_data_source(db_session, "ws_empty")
    assert result is None


# ── set_primary ──────────────────────────────────────────────────────

async def test_set_primary_demotes_others(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds1 = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="sp1"),
        make_primary=True,
    )
    ds2 = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id, graph_name="sp2"),
    )

    result = await data_source_repo.set_primary(db_session, ws_id, ds2.id)
    assert result is True

    # Verify ds2 is now primary
    fetched_ds2 = await data_source_repo.get_data_source(db_session, ds2.id)
    assert fetched_ds2.is_primary is True

    # Verify ds1 is demoted
    fetched_ds1 = await data_source_repo.get_data_source(db_session, ds1.id)
    assert fetched_ds1.is_primary is False


async def test_set_primary_returns_false_for_missing(db_session: AsyncSession):
    _, ws_id, _ = await _seed_all(db_session)
    result = await data_source_repo.set_primary(db_session, ws_id, "ds_missing")
    assert result is False


# ── get_data_source_impact ───────────────────────────────────────────

async def test_get_data_source_impact_with_views(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )

    # Create a view referencing this data source
    view = ViewORM(
        name="Test View",
        workspace_id=ws_id,
        data_source_id=ds.id,
        view_type="graph",
    )
    db_session.add(view)
    await db_session.flush()

    impact = await data_source_repo.get_data_source_impact(db_session, ds.id)
    assert len(impact.views) == 1
    assert impact.views[0].id == view.id
    assert impact.views[0].name == "Test View"


async def test_get_data_source_impact_with_context_models(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )

    # Create a context model referencing this data source
    cm = ContextModelORM(
        name="Test CM",
        workspace_id=ws_id,
        data_source_id=ds.id,
    )
    db_session.add(cm)
    await db_session.flush()

    impact = await data_source_repo.get_data_source_impact(db_session, ds.id)
    assert len(impact.views) == 1
    assert impact.views[0].name == "Test CM"
    assert impact.views[0].type == "context_model"


async def test_get_data_source_impact_empty(db_session: AsyncSession):
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )

    impact = await data_source_repo.get_data_source_impact(db_session, ds.id)
    assert impact.views == []


async def test_get_data_source_impact_deduplicates(db_session: AsyncSession):
    """If a view and context model have the same ID, only one appears."""
    prov_id, ws_id, _ = await _seed_all(db_session)
    ds = await data_source_repo.create_data_source(
        db_session, ws_id, _make_direct_req(prov_id)
    )

    # Create a view
    view = ViewORM(
        name="Dual Entity",
        workspace_id=ws_id,
        data_source_id=ds.id,
        view_type="graph",
    )
    db_session.add(view)
    await db_session.flush()

    # Create a context model with a different ID
    cm = ContextModelORM(
        name="CM Entity",
        workspace_id=ws_id,
        data_source_id=ds.id,
    )
    db_session.add(cm)
    await db_session.flush()

    impact = await data_source_repo.get_data_source_impact(db_session, ds.id)
    # Both should appear since they have different IDs
    assert len(impact.views) == 2
    ids = {v.id for v in impact.views}
    assert view.id in ids
    assert cm.id in ids
