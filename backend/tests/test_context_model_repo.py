"""
Unit tests for backend.app.db.repositories.context_model_repo
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import context_model_repo
from backend.app.db.models import WorkspaceORM, ProviderORM, WorkspaceDataSourceORM
from backend.common.models.management import (
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    ContextModelResponse,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_workspace(session: AsyncSession, ws_id="ws_test1") -> str:
    ws = WorkspaceORM(id=ws_id, name="Test Workspace")
    session.add(ws)
    await session.flush()
    return ws_id


async def _seed_data_source(
    session: AsyncSession, ws_id: str, ds_id="ds_test1"
) -> str:
    prov = ProviderORM(id="prov_cm_test", name="CM Provider", provider_type="falkordb")
    session.add(prov)
    await session.flush()
    ds = WorkspaceDataSourceORM(
        id=ds_id, workspace_id=ws_id, provider_id=prov.id, graph_name="test-g"
    )
    session.add(ds)
    await session.flush()
    return ds_id


def _make_create_req(**overrides) -> ContextModelCreateRequest:
    defaults = dict(
        name="Test Context Model",
        description="A test context model",
        is_template=False,
        category="data-engineering",
        layers_config=[{"type": "entity", "entityTypes": ["Dataset"]}],
        scope_filter={"rootTypes": ["Database"]},
        instance_assignments={"node_1": "layer_0"},
        scope_edge_config={"edgeTypes": ["CONTAINS"]},
    )
    defaults.update(overrides)
    return ContextModelCreateRequest(**defaults)


def _make_template_req(**overrides) -> ContextModelCreateRequest:
    defaults = dict(
        name="Template Model",
        description="A reusable template",
        is_template=True,
        category="data-engineering",
        layers_config=[{"type": "entity", "entityTypes": ["Table"]}],
        scope_filter=None,
        instance_assignments={},
    )
    defaults.update(overrides)
    return ContextModelCreateRequest(**defaults)


# ── create ────────────────────────────────────────────────────────────

async def test_create_context_model(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    req = _make_create_req()
    resp = await context_model_repo.create_context_model(
        db_session, req, workspace_id=ws_id
    )

    assert isinstance(resp, ContextModelResponse)
    assert resp.id is not None
    assert resp.name == "Test Context Model"
    assert resp.description == "A test context model"
    assert resp.workspace_id == ws_id
    assert resp.is_template is False
    assert resp.category == "data-engineering"
    assert resp.layers_config == [{"type": "entity", "entityTypes": ["Dataset"]}]
    assert resp.scope_filter == {"rootTypes": ["Database"]}
    assert resp.instance_assignments == {"node_1": "layer_0"}
    assert resp.scope_edge_config == {"edgeTypes": ["CONTAINS"]}
    assert resp.is_active is True
    assert resp.created_at is not None


async def test_create_context_model_template(db_session: AsyncSession):
    req = _make_template_req()
    resp = await context_model_repo.create_context_model(db_session, req)

    assert resp.is_template is True
    assert resp.workspace_id is None


async def test_create_context_model_with_data_source(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    ds_id = await _seed_data_source(db_session, ws_id)
    req = _make_create_req()
    resp = await context_model_repo.create_context_model(
        db_session, req, workspace_id=ws_id, data_source_id=ds_id
    )

    assert resp.data_source_id == ds_id


# ── get ───────────────────────────────────────────────────────────────

async def test_get_context_model_returns_created(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    created = await context_model_repo.create_context_model(
        db_session, _make_create_req(), workspace_id=ws_id
    )
    fetched = await context_model_repo.get_context_model(db_session, created.id)

    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_context_model_returns_none_for_missing(db_session: AsyncSession):
    result = await context_model_repo.get_context_model(db_session, "cm_nonexistent")
    assert result is None


# ── list ──────────────────────────────────────────────────────────────

async def test_list_context_models_all(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    await context_model_repo.create_context_model(
        db_session, _make_create_req(name="CM1"), workspace_id=ws_id
    )
    await context_model_repo.create_context_model(
        db_session, _make_template_req(name="TPL1")
    )

    result = await context_model_repo.list_context_models(db_session)
    assert len(result) == 2


async def test_list_context_models_by_workspace(db_session: AsyncSession):
    ws1 = await _seed_workspace(db_session, ws_id="ws_list1")
    ws2 = await _seed_workspace(db_session, ws_id="ws_list2")

    await context_model_repo.create_context_model(
        db_session, _make_create_req(name="WS1 CM"), workspace_id=ws1
    )
    await context_model_repo.create_context_model(
        db_session, _make_create_req(name="WS2 CM"), workspace_id=ws2
    )

    result = await context_model_repo.list_context_models(db_session, workspace_id=ws1)
    assert len(result) == 1
    assert result[0].name == "WS1 CM"


async def test_list_context_models_templates_only(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    await context_model_repo.create_context_model(
        db_session, _make_create_req(name="Instance"), workspace_id=ws_id
    )
    await context_model_repo.create_context_model(
        db_session, _make_template_req(name="Template")
    )

    result = await context_model_repo.list_context_models(
        db_session, templates_only=True
    )
    assert len(result) == 1
    assert result[0].name == "Template"
    assert result[0].is_template is True


async def test_list_context_models_empty(db_session: AsyncSession):
    result = await context_model_repo.list_context_models(db_session)
    assert result == []


# ── update ────────────────────────────────────────────────────────────

async def test_update_context_model_partial(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    created = await context_model_repo.create_context_model(
        db_session, _make_create_req(), workspace_id=ws_id
    )
    update_req = ContextModelUpdateRequest(name="Renamed")
    updated = await context_model_repo.update_context_model(
        db_session, created.id, update_req
    )

    assert updated is not None
    assert updated.name == "Renamed"
    assert updated.description == "A test context model"  # unchanged


async def test_update_context_model_all_fields(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    created = await context_model_repo.create_context_model(
        db_session, _make_create_req(), workspace_id=ws_id
    )
    new_layers = [{"type": "relationship", "edgeTypes": ["DEPENDS_ON"]}]
    new_scope = {"rootTypes": ["Schema"]}
    new_assignments = {"node_x": "layer_1"}
    new_edge_config = {"edgeTypes": ["REFERENCES"]}

    update_req = ContextModelUpdateRequest(
        name="Fully Updated",
        description="New description",
        layers_config=new_layers,
        scope_filter=new_scope,
        instance_assignments=new_assignments,
        scope_edge_config=new_edge_config,
    )
    updated = await context_model_repo.update_context_model(
        db_session, created.id, update_req
    )

    assert updated.name == "Fully Updated"
    assert updated.description == "New description"
    assert updated.layers_config == new_layers
    assert updated.scope_filter == new_scope
    assert updated.instance_assignments == new_assignments
    assert updated.scope_edge_config == new_edge_config


async def test_update_context_model_returns_none_for_missing(db_session: AsyncSession):
    update_req = ContextModelUpdateRequest(name="Nope")
    result = await context_model_repo.update_context_model(
        db_session, "cm_missing", update_req
    )
    assert result is None


# ── delete ────────────────────────────────────────────────────────────

async def test_delete_context_model_success(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    created = await context_model_repo.create_context_model(
        db_session, _make_create_req(), workspace_id=ws_id
    )
    deleted = await context_model_repo.delete_context_model(db_session, created.id)
    assert deleted is True

    fetched = await context_model_repo.get_context_model(db_session, created.id)
    assert fetched is None


async def test_delete_context_model_returns_false_for_missing(db_session: AsyncSession):
    result = await context_model_repo.delete_context_model(db_session, "cm_ghost")
    assert result is False


# ── instantiate_template ──────────────────────────────────────────────

async def test_instantiate_template_success(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)

    template = await context_model_repo.create_context_model(
        db_session, _make_template_req(name="My Template")
    )

    instance = await context_model_repo.instantiate_template(
        db_session,
        template_id=template.id,
        workspace_id=ws_id,
        name="Instance from template",
    )

    assert instance is not None
    assert instance.name == "Instance from template"
    assert instance.workspace_id == ws_id
    assert instance.is_template is False
    assert instance.category == template.category
    assert instance.layers_config == template.layers_config
    assert instance.instance_assignments == {}  # fresh, not copied from template
    assert "Created from template: My Template" in instance.description


async def test_instantiate_template_with_data_source(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    ds_id = await _seed_data_source(db_session, ws_id)

    template = await context_model_repo.create_context_model(
        db_session, _make_template_req()
    )

    instance = await context_model_repo.instantiate_template(
        db_session,
        template_id=template.id,
        workspace_id=ws_id,
        name="DS Instance",
        data_source_id=ds_id,
    )

    assert instance is not None
    assert instance.data_source_id == ds_id


async def test_instantiate_template_returns_none_for_nonexistent(db_session: AsyncSession):
    ws_id = await _seed_workspace(db_session)
    result = await context_model_repo.instantiate_template(
        db_session, template_id="cm_fake", workspace_id=ws_id, name="Nope"
    )
    assert result is None


async def test_instantiate_template_returns_none_for_non_template(db_session: AsyncSession):
    """Cannot instantiate a non-template context model."""
    ws_id = await _seed_workspace(db_session)
    non_template = await context_model_repo.create_context_model(
        db_session, _make_create_req(is_template=False), workspace_id=ws_id
    )
    result = await context_model_repo.instantiate_template(
        db_session, template_id=non_template.id, workspace_id=ws_id, name="Nope"
    )
    assert result is None
