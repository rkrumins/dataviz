"""
The scoped mapping end-to-end through the repositories: persistence, the
clear-to-inherit contract, the provenance a client needs, and the invalidation
a change has to fan out.
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    PlatformSettingsORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import data_source_repo, provider_repo, workspace_repo
from backend.app.services.node_identity import (
    invalidate_global_defaults_cache,
    scopes_resolving_through,
)
from backend.common.models.management import (
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    ProviderUpdateRequest,
    WorkspaceUpdateRequest,
)


@pytest.fixture(autouse=True)
def _clear_defaults_cache():
    invalidate_global_defaults_cache()
    yield
    invalidate_global_defaults_cache()


async def _seed(session: AsyncSession, *, prov=None, ws=None):
    session.add(ProviderORM(
        id="prov_s", name="P", provider_type="falkordb", **(prov or {})))
    session.add(WorkspaceORM(id="ws_s", name="W", **(ws or {})))
    await session.flush()


def _ds_req(**kw) -> DataSourceCreateRequest:
    return DataSourceCreateRequest(providerId="prov_s", graphName="g", **kw)


# ── provider scope ────────────────────────────────────────────────────

async def test_provider_default_reaches_a_source_that_sets_nothing(db_session: AsyncSession):
    await _seed(db_session, prov={"identity_property": "id", "name_property": "title"})
    ds = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())
    assert ds.identity_property == "id"
    assert ds.identity_property_source == "provider"
    assert ds.name_property == "title"
    assert ds.name_property_source == "provider"


async def test_source_override_beats_the_provider_default(db_session: AsyncSession):
    await _seed(db_session, prov={"identity_property": "id"})
    ds = await data_source_repo.create_data_source(
        db_session, "ws_s", _ds_req(identityProperty="uuid"))
    assert ds.identity_property == "uuid"
    assert ds.identity_property_source == "data_source"


async def test_provider_beats_workspace(db_session: AsyncSession):
    """The provider describes what the graphs on that connection look like; the
    workspace only states a preference. When both speak, the data wins."""
    await _seed(
        db_session,
        prov={"identity_property": "id"},
        ws={"identity_property": "_id"},
    )
    ds = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())
    assert (ds.identity_property, ds.identity_property_source) == ("id", "provider")


async def test_workspace_default_applies_when_the_provider_is_silent(db_session: AsyncSession):
    await _seed(db_session, ws={"identity_property": "_id"})
    ds = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())
    assert (ds.identity_property, ds.identity_property_source) == ("_id", "workspace")


async def test_platform_default_is_the_floor(db_session: AsyncSession):
    await _seed(db_session)
    db_session.add(PlatformSettingsORM(id=1, identity_property="identifier"))
    await db_session.flush()
    ds = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())
    assert (ds.identity_property, ds.identity_property_source) == ("identifier", "global")


# ── the clear-to-inherit contract ─────────────────────────────────────

async def test_clearing_a_source_override_restores_inheritance(db_session: AsyncSession):
    """The whole point of the chain. Storing the literal default on clear (as
    this did before the other scopes existed) pinned the source to `urn`
    forever and made this the one edit you could not express."""
    await _seed(db_session, prov={"identity_property": "id"})
    created = await data_source_repo.create_data_source(
        db_session, "ws_s", _ds_req(identityProperty="uuid"))

    cleared = await data_source_repo.update_data_source(
        db_session, created.id, DataSourceUpdateRequest(identityProperty=""))
    assert (cleared.identity_property, cleared.identity_property_source) == ("id", "provider")

    row = await db_session.get(WorkspaceDataSourceORM, created.id)
    assert row.identity_property is None, "cleared override must be NULL on disk, not 'urn'"


async def test_clearing_a_provider_default_restores_inheritance(db_session: AsyncSession):
    await _seed(db_session, prov={"identity_property": "id"}, ws={"identity_property": "_id"})
    ds = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())
    assert ds.identity_property == "id"

    await provider_repo.update_provider(
        db_session, "prov_s", ProviderUpdateRequest(identityProperty=""))
    refreshed = await data_source_repo.get_data_source(db_session, ds.id)
    assert (refreshed.identity_property, refreshed.identity_property_source) == ("_id", "workspace")


async def test_omitting_the_field_leaves_every_scope_untouched(db_session: AsyncSession):
    await _seed(db_session, prov={"identity_property": "id"})
    ds = await data_source_repo.create_data_source(
        db_session, "ws_s", _ds_req(identityProperty="uuid"))
    updated = await data_source_repo.update_data_source(
        db_session, ds.id, DataSourceUpdateRequest(label="renamed"))
    assert updated.identity_property == "uuid"


# ── provenance is reported by BOTH serializers ────────────────────────

async def test_workspace_read_reports_the_same_resolution(db_session: AsyncSession):
    """workspace_repo has its own parallel data-source serializer. Omitting
    these fields there is exactly how a saved mapping previously read back as
    the default on refresh."""
    await _seed(db_session, prov={"identity_property": "id", "name_property": "title"})
    await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())

    ws = await workspace_repo.get_workspace(db_session, "ws_s")
    assert len(ws.data_sources) == 1
    ds = ws.data_sources[0]
    assert (ds.identity_property, ds.identity_property_source) == ("id", "provider")
    assert (ds.name_property, ds.name_property_source) == ("title", "provider")


async def test_workspace_response_carries_its_own_defaults(db_session: AsyncSession):
    await _seed(db_session, ws={"identity_property": "_id"})
    ws = await workspace_repo.get_workspace(db_session, "ws_s")
    assert ws.identity_property == "_id"


async def test_workspace_update_persists_and_clears_its_default(db_session: AsyncSession):
    await _seed(db_session)
    await workspace_repo.update_workspace(
        db_session, "ws_s", WorkspaceUpdateRequest(identityProperty="_id"))
    assert (await workspace_repo.get_workspace(db_session, "ws_s")).identity_property == "_id"

    await workspace_repo.update_workspace(
        db_session, "ws_s", WorkspaceUpdateRequest(identityProperty=""))
    row = await db_session.get(WorkspaceORM, "ws_s")
    assert row.identity_property is None


# ── who a scope change actually reaches ───────────────────────────────

async def test_scope_fanout_skips_sources_that_override_both(db_session: AsyncSession):
    """A source that sets both properties itself did not move when the provider
    changed, so demanding a re-aggregation of it would be busywork."""
    await _seed(db_session, prov={"identity_property": "id"})
    inheriting = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())
    overriding = await data_source_repo.create_data_source(
        db_session, "ws_s",
        DataSourceCreateRequest(
            providerId="prov_s", graphName="g2",
            identityProperty="uuid", nameProperty="title"))

    reached = {ds for (_ws, ds) in
               await scopes_resolving_through(db_session, provider_id="prov_s")}
    assert inheriting.id in reached
    assert overriding.id not in reached


async def test_scope_fanout_includes_a_partial_override(db_session: AsyncSession):
    """Overriding only the identity still leaves the display name inherited, so
    the source IS affected by a provider change."""
    await _seed(db_session, prov={"identity_property": "id"})
    partial = await data_source_repo.create_data_source(
        db_session, "ws_s", _ds_req(identityProperty="uuid"))
    reached = {ds for (_ws, ds) in
               await scopes_resolving_through(db_session, provider_id="prov_s")}
    assert partial.id in reached


async def test_scope_fanout_narrows_to_the_named_scope(db_session: AsyncSession):
    await _seed(db_session)
    session_ds = await data_source_repo.create_data_source(db_session, "ws_s", _ds_req())

    db_session.add(ProviderORM(id="prov_other", name="O", provider_type="falkordb"))
    db_session.add(WorkspaceORM(id="ws_other", name="O"))
    await db_session.flush()
    other = await data_source_repo.create_data_source(
        db_session, "ws_other",
        DataSourceCreateRequest(providerId="prov_other", graphName="g2"))

    by_provider = {ds for (_ws, ds) in
                   await scopes_resolving_through(db_session, provider_id="prov_s")}
    assert by_provider == {session_ds.id}

    by_workspace = {ds for (_ws, ds) in
                    await scopes_resolving_through(db_session, workspace_id="ws_other")}
    assert by_workspace == {other.id}

    everything = {ds for (_ws, ds) in await scopes_resolving_through(db_session)}
    assert {session_ds.id, other.id} <= everything
