"""
Provenance serialization: source_mode / write_back_enabled must survive the
ORM → DataSourceResponse mapping in BOTH repos (workspace_repo nests data
sources under workspaces; data_source_repo serves the flat per-workspace
list). Added for the View wizard's managed/federated badges.
"""
from sqlalchemy import select

from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM
from backend.app.db.repositories import data_source_repo, workspace_repo
from backend.common.models.management import (
    DataSourceCreateRequest,
    WorkspaceCreateRequest,
)


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_workspace_with_ds(session, *, name="prov-ws", provider_id="prov_pv1"):
    """Provider + workspace with one direct (provider+graph) data source."""
    session.add(ProviderORM(
        id=provider_id,
        name="Provenance Test Provider",
        provider_type="falkordb",
        host="localhost",
        port=6379,
    ))
    await session.flush()
    return await workspace_repo.create_workspace(
        session,
        WorkspaceCreateRequest(
            name=name,
            description=None,
            data_sources=[
                DataSourceCreateRequest(provider_id=provider_id, graph_name=f"{name}-g1")
            ],
        ),
    )


async def _ds_row(session, workspace_id):
    result = await session.execute(
        select(WorkspaceDataSourceORM).where(
            WorkspaceDataSourceORM.workspace_id == workspace_id
        )
    )
    return result.scalar_one()


# ── workspace_repo nesting path ──────────────────────────────────────

async def test_source_mode_serialized_in_workspace_nesting(db_session):
    ws = await _seed_workspace_with_ds(db_session)
    row = await _ds_row(db_session, ws.id)
    row.source_mode = "federated"
    row.write_back_enabled = True
    await db_session.flush()

    got = await workspace_repo.get_workspace(db_session, ws.id)
    ds = got.data_sources[0]
    assert ds.source_mode == "federated"
    assert ds.write_back_enabled is True

    # camelCase aliases on the wire
    dumped = ds.model_dump(by_alias=True)
    assert dumped["sourceMode"] == "federated"
    assert dumped["writeBackEnabled"] is True


# ── data_source_repo flat-list path ──────────────────────────────────

async def test_source_mode_serialized_in_flat_list(db_session):
    ws = await _seed_workspace_with_ds(db_session, name="prov-ws-2", provider_id="prov_pv2")
    row = await _ds_row(db_session, ws.id)
    row.source_mode = "managed"
    await db_session.flush()

    listed = await data_source_repo.list_data_sources(db_session, ws.id)
    assert listed[0].source_mode == "managed"
    assert listed[0].write_back_enabled is False


# ── legacy rows (no source_mode set) ─────────────────────────────────

async def test_legacy_rows_default_to_null_mode(db_session):
    ws = await _seed_workspace_with_ds(db_session, name="prov-ws-3", provider_id="prov_pv3")

    got = await workspace_repo.get_workspace(db_session, ws.id)
    ds = got.data_sources[0]
    assert ds.source_mode is None  # client derives from shape
    assert ds.write_back_enabled is False
