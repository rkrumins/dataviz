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


# ── restriction: the same both-serializers hazard ────────────────────

async def test_is_restricted_survives_both_serializers(db_session):
    """A restricted source decides whether views over it can be
    published, and the admin toggle reads whichever serializer served
    the page it is on. Dropping the field in one of them would render
    the toggle off for a source that IS restricted — the reading a
    person would trust before publishing.
    """
    ws = await _seed_workspace_with_ds(db_session, name="restr-ws", provider_id="prov_restr")
    row = await _ds_row(db_session, ws.id)
    row.is_restricted = True
    await db_session.flush()

    nested = (await workspace_repo.get_workspace(db_session, ws.id)).data_sources[0]
    assert nested.is_restricted is True
    assert nested.model_dump(by_alias=True)["isRestricted"] is True

    listed = await data_source_repo.list_data_sources(db_session, ws.id)
    assert listed[0].is_restricted is True


_METADATA = ("description", "catalogDescription", "tags", "classification", "trustStatus")


def _metadata(ds) -> dict:
    dumped = ds.model_dump(by_alias=True)
    return {k: dumped[k] for k in _METADATA}


async def test_both_serializers_emit_the_same_details(db_session):
    """Every list and card shows a source's description, tags and trust badges from
    whichever serializer served it — the workspace read or the flat list — so the two
    must agree, the catalog item's description included."""
    from backend.app.db.models import CatalogItemORM

    ws = await _seed_workspace_with_ds(db_session, name="meta-ws", provider_id="prov_meta")
    db_session.add(CatalogItemORM(id="cat_meta", provider_id="prov_meta", source_identifier="meta-ws-g1",
                                  name="Ledger", description="The general ledger, nightly."))
    await db_session.flush()
    row = await _ds_row(db_session, ws.id)
    row.catalog_item_id = "cat_meta"
    row.description = "Month-end figures."
    row.tags = '["finance", "gl"]'
    row.classification = "confidential"
    row.trust_status = "certified"
    await db_session.flush()
    db_session.expunge_all()

    nested = _metadata((await workspace_repo.get_workspace(db_session, ws.id)).data_sources[0])
    db_session.expunge_all()
    listed = _metadata((await data_source_repo.list_data_sources(db_session, ws.id))[0])
    assert nested == listed == {
        "description": "Month-end figures.", "catalogDescription": "The general ledger, nightly.",
        "tags": ["finance", "gl"], "classification": "confidential", "trustStatus": "certified",
    }


async def test_a_source_with_no_details_reads_as_empty_in_both(db_session):
    ws = await _seed_workspace_with_ds(db_session, name="meta-ws-2", provider_id="prov_meta2")
    nested = _metadata((await workspace_repo.get_workspace(db_session, ws.id)).data_sources[0])
    listed = _metadata((await data_source_repo.list_data_sources(db_session, ws.id))[0])
    assert nested == listed == {
        "description": None, "catalogDescription": None, "tags": [], "classification": None, "trustStatus": None,
    }


async def test_sources_are_unrestricted_until_someone_says_otherwise(db_session):
    ws = await _seed_workspace_with_ds(db_session, name="restr-ws-2", provider_id="prov_restr2")
    nested = (await workspace_repo.get_workspace(db_session, ws.id)).data_sources[0]
    assert nested.is_restricted is False
