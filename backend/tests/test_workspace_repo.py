"""
Unit tests for backend.app.db.repositories.workspace_repo
"""
from backend.app.db.repositories import workspace_repo
from backend.app.db.models import ProviderORM, CatalogItemORM
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    DataSourceCreateRequest,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_catalog(session, provider_id="prov_test1", catalog_id="cat_test1"):
    """Insert a ProviderORM + CatalogItemORM so workspace creation can resolve data sources."""
    provider = ProviderORM(
        id=provider_id,
        name="Test Provider",
        provider_type="mock",
        host="localhost",
        port=6379,
    )
    session.add(provider)

    catalog = CatalogItemORM(
        id=catalog_id,
        provider_id=provider_id,
        name="test-graph",
        source_identifier="test-graph",
    )
    session.add(catalog)
    await session.flush()
    return provider_id, catalog_id


def _make_create_req(
    name="test-workspace",
    description="A test workspace",
    data_sources=None,
) -> WorkspaceCreateRequest:
    if data_sources is None:
        data_sources = []
    return WorkspaceCreateRequest(
        name=name,
        description=description,
        data_sources=data_sources,
    )


# ── create (no data sources) ─────────────────────────────────────────

async def test_create_workspace_no_data_sources(db_session):
    req = _make_create_req()
    resp = await workspace_repo.create_workspace(db_session, req)

    assert resp.id is not None
    assert resp.name == "test-workspace"
    assert resp.description == "A test workspace"
    assert resp.is_default is False
    assert resp.is_active is True
    assert resp.data_sources == []
    assert resp.created_at is not None


async def test_create_workspace_make_default(db_session):
    req = _make_create_req(name="default-ws")
    resp = await workspace_repo.create_workspace(db_session, req, make_default=True)

    assert resp.is_default is True


# ── create (with data sources) ───────────────────────────────────────

async def test_create_workspace_with_data_sources(db_session):
    _prov_id, cat_id = await _seed_catalog(db_session)

    ds_req = DataSourceCreateRequest(catalog_item_id=cat_id, label="My Graph")
    req = _make_create_req(name="ws-with-ds", data_sources=[ds_req])
    resp = await workspace_repo.create_workspace(db_session, req)

    assert resp.name == "ws-with-ds"
    assert len(resp.data_sources) == 1

    ds = resp.data_sources[0]
    assert ds.catalog_item_id == cat_id
    assert ds.label == "My Graph"
    assert ds.is_primary is True  # first data source is primary
    assert ds.is_active is True
    assert ds.graph_name == "test-graph"  # resolved from catalog item


async def test_create_workspace_data_source_label_from_catalog(db_session):
    """When label is not provided, it falls back to catalog item name."""
    _prov_id, cat_id = await _seed_catalog(
        db_session, provider_id="prov_lbl", catalog_id="cat_lbl"
    )

    ds_req = DataSourceCreateRequest(catalog_item_id=cat_id)
    req = _make_create_req(name="ws-auto-label", data_sources=[ds_req])
    resp = await workspace_repo.create_workspace(db_session, req)

    ds = resp.data_sources[0]
    # label should resolve to catalog item name or source_identifier
    assert ds.label is not None
    assert ds.label != ""


# ── get ───────────────────────────────────────────────────────────────

async def test_get_workspace_returns_created(db_session):
    created = await workspace_repo.create_workspace(db_session, _make_create_req())

    fetched = await workspace_repo.get_workspace(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_workspace_returns_none_for_missing(db_session):
    result = await workspace_repo.get_workspace(db_session, "ws_nonexistent")
    assert result is None


async def test_get_workspace_includes_data_sources(db_session):
    _prov_id, cat_id = await _seed_catalog(
        db_session, provider_id="prov_get", catalog_id="cat_get"
    )

    ds_req = DataSourceCreateRequest(catalog_item_id=cat_id, label="ds-label")
    req = _make_create_req(name="ws-get-ds", data_sources=[ds_req])
    created = await workspace_repo.create_workspace(db_session, req)

    fetched = await workspace_repo.get_workspace(db_session, created.id)
    assert fetched is not None
    assert len(fetched.data_sources) == 1
    assert fetched.data_sources[0].label == "ds-label"


# ── list ──────────────────────────────────────────────────────────────

async def test_list_workspaces(db_session):
    await workspace_repo.create_workspace(db_session, _make_create_req(name="ws1"))
    await workspace_repo.create_workspace(db_session, _make_create_req(name="ws2"))
    await workspace_repo.create_workspace(db_session, _make_create_req(name="ws3"))

    result = await workspace_repo.list_workspaces(db_session)
    assert len(result) == 3
    names = {ws.name for ws in result}
    assert names == {"ws1", "ws2", "ws3"}


# ── update ────────────────────────────────────────────────────────────

async def test_update_workspace_name_and_description(db_session):
    created = await workspace_repo.create_workspace(db_session, _make_create_req())

    update_req = WorkspaceUpdateRequest(name="renamed", description="new desc")
    updated = await workspace_repo.update_workspace(db_session, created.id, update_req)

    assert updated is not None
    assert updated.name == "renamed"
    assert updated.description == "new desc"


async def test_update_workspace_returns_none_for_missing(db_session):
    update_req = WorkspaceUpdateRequest(name="nope")
    result = await workspace_repo.update_workspace(db_session, "ws_missing", update_req)
    assert result is None


# ── delete ────────────────────────────────────────────────────────────

async def test_delete_workspace_success(db_session):
    created = await workspace_repo.create_workspace(db_session, _make_create_req())

    deleted = await workspace_repo.delete_workspace(db_session, created.id)
    assert deleted is True

    fetched = await workspace_repo.get_workspace(db_session, created.id)
    assert fetched is None


async def test_delete_workspace_returns_false_for_missing(db_session):
    result = await workspace_repo.delete_workspace(db_session, "ws_ghost")
    assert result is False


# ── set_default / get_default ─────────────────────────────────────────

async def test_set_default_demotes_others(db_session):
    ws1 = await workspace_repo.create_workspace(
        db_session, _make_create_req(name="ws1"), make_default=True
    )
    ws2 = await workspace_repo.create_workspace(
        db_session, _make_create_req(name="ws2")
    )

    result = await workspace_repo.set_default(db_session, ws2.id)
    assert result is True

    fetched_ws1 = await workspace_repo.get_workspace(db_session, ws1.id)
    fetched_ws2 = await workspace_repo.get_workspace(db_session, ws2.id)
    assert fetched_ws1.is_default is False
    assert fetched_ws2.is_default is True


async def test_get_default_workspace(db_session):
    await workspace_repo.create_workspace(
        db_session, _make_create_req(name="not-default")
    )
    default = await workspace_repo.create_workspace(
        db_session, _make_create_req(name="default"), make_default=True
    )

    result = await workspace_repo.get_default_workspace(db_session)
    assert result is not None
    assert result.id == default.id


async def test_get_default_workspace_returns_none_when_no_default(db_session):
    await workspace_repo.create_workspace(db_session, _make_create_req())
    result = await workspace_repo.get_default_workspace(db_session)
    assert result is None
