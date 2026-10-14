"""``default_data_source_ids`` is ``get_primary_data_source`` for many workspaces.

A view with no data source reads its workspace's default, and the Explorer's
Versioned/External filter classifies it by that default in bulk. If the bulk
rule and the single-workspace rule ever disagree, the filter and the view
itself disagree about which data the view shows.
"""
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import data_source_repo

# workspace → its sources as (id, created_at, flags)
SCENARIOS = {
    # The primary wins even though another source is older.
    "ws_primary": [
        ("ds_p_old", "2026-01-01", {}),
        ("ds_p_main", "2026-02-01", {"primary": True}),
    ],
    # No primary: the earliest-created active source.
    "ws_no_primary": [
        ("ds_n_late", "2026-03-01", {}),
        ("ds_n_early", "2026-01-15", {}),
    ],
    # A paused primary does not serve; neither does a paused older source.
    "ws_inactive_primary": [
        ("ds_i_main", "2026-01-01", {"primary": True, "active": False}),
        ("ds_i_paused", "2026-01-02", {"active": False}),
        ("ds_i_next", "2026-01-03", {}),
    ],
    # A primary in the trash does not serve; neither does an older trashed one.
    "ws_deleted_primary": [
        ("ds_d_main", "2026-01-01", {"primary": True, "deleted": True}),
        ("ds_d_trash", "2026-01-02", {"deleted": True}),
        ("ds_d_next", "2026-01-03", {}),
    ],
    # Nothing that can serve: no default at all.
    "ws_nothing_live": [
        ("ds_z_paused", "2026-01-01", {"active": False}),
        ("ds_z_trash", "2026-01-02", {"deleted": True}),
    ],
    "ws_empty": [],
}


async def _seed(session):
    session.add(ProviderORM(id="prov_1", name="P", provider_type="falkordb"))
    for ws_id, sources in SCENARIOS.items():
        session.add(WorkspaceORM(id=ws_id, name=ws_id))
        for ds_id, created, flags in sources:
            session.add(WorkspaceDataSourceORM(
                id=ds_id, workspace_id=ws_id, provider_id="prov_1", graph_name=ds_id,
                is_primary=flags.get("primary", False),
                is_active=flags.get("active", True),
                created_at=f"{created}T00:00:00+00:00",
                deleted_at="2026-09-01T00:00:00+00:00" if flags.get("deleted") else None,
            ))
    await session.commit()


async def test_matches_get_primary_data_source_for_every_workspace(db_session):
    await _seed(db_session)
    bulk = await data_source_repo.default_data_source_ids(db_session)
    for ws_id in SCENARIOS:
        single = await data_source_repo.get_primary_data_source(db_session, ws_id)
        assert bulk.get(ws_id) == (single.id if single else None), ws_id
    assert bulk == {
        "ws_primary": "ds_p_main",
        "ws_no_primary": "ds_n_early",
        "ws_inactive_primary": "ds_i_next",
        "ws_deleted_primary": "ds_d_next",
    }


async def test_workspace_filter(db_session):
    await _seed(db_session)
    assert await data_source_repo.default_data_source_ids(
        db_session, ["ws_primary", "ws_empty"],
    ) == {"ws_primary": "ds_p_main"}
    assert await data_source_repo.default_data_source_ids(db_session, []) == {}
