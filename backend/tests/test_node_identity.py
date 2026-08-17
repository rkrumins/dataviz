"""
Unit tests for backend.app.services.node_identity — the four-scope resolution
chain (data source → provider → workspace → platform default → code default).
"""
import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    PlatformSettingsORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.node_identity import (
    DEFAULT_IDENTITY_PROPERTY,
    DEFAULT_NAME_PROPERTY,
    SOURCE_DATA_SOURCE,
    SOURCE_DEFAULT,
    SOURCE_GLOBAL,
    SOURCE_PROVIDER,
    SOURCE_WORKSPACE,
    PlatformNodeIdentityDefaults,
    invalidate_global_defaults_cache,
    load_node_identity,
    provider_identity_from_extra_config,
    resolve_node_identity,
)


class _Level:
    """Stand-in for any ORM row in the chain."""

    def __init__(self, identity=None, name=None):
        self.identity_property = identity
        self.name_property = name


# ── precedence ────────────────────────────────────────────────────────

def test_nothing_set_resolves_to_code_defaults():
    r = resolve_node_identity()
    assert r.identity_property == DEFAULT_IDENTITY_PROPERTY
    assert r.name_property == DEFAULT_NAME_PROPERTY
    assert r.identity_source == SOURCE_DEFAULT
    assert r.name_source == SOURCE_DEFAULT
    assert r.is_default


def test_data_source_beats_every_other_level():
    r = resolve_node_identity(
        data_source=_Level("dsId", "dsName"),
        provider=_Level("provId", "provName"),
        workspace=_Level("wsId", "wsName"),
        defaults=PlatformNodeIdentityDefaults("globalId", "globalName"),
    )
    assert (r.identity_property, r.identity_source) == ("dsId", SOURCE_DATA_SOURCE)
    assert (r.name_property, r.name_source) == ("dsName", SOURCE_DATA_SOURCE)


def test_provider_beats_workspace_and_global():
    r = resolve_node_identity(
        data_source=_Level(),
        provider=_Level("provId", "provName"),
        workspace=_Level("wsId", "wsName"),
        defaults=PlatformNodeIdentityDefaults("globalId", "globalName"),
    )
    assert (r.identity_property, r.identity_source) == ("provId", SOURCE_PROVIDER)
    assert (r.name_property, r.name_source) == ("provName", SOURCE_PROVIDER)


def test_workspace_beats_global():
    r = resolve_node_identity(
        workspace=_Level("wsId", "wsName"),
        defaults=PlatformNodeIdentityDefaults("globalId", "globalName"),
    )
    assert (r.identity_property, r.identity_source) == ("wsId", SOURCE_WORKSPACE)
    assert (r.name_property, r.name_source) == ("wsName", SOURCE_WORKSPACE)


def test_global_beats_code_default():
    r = resolve_node_identity(
        defaults=PlatformNodeIdentityDefaults("globalId", "globalName"),
    )
    assert (r.identity_property, r.identity_source) == ("globalId", SOURCE_GLOBAL)
    assert (r.name_property, r.name_source) == ("globalName", SOURCE_GLOBAL)


def test_missing_levels_are_skipped():
    """A caller holding only part of the chain passes what it has."""
    r = resolve_node_identity(data_source=None, provider=None, workspace=_Level("wsId"))
    assert (r.identity_property, r.identity_source) == ("wsId", SOURCE_WORKSPACE)
    assert (r.name_property, r.name_source) == (DEFAULT_NAME_PROPERTY, SOURCE_DEFAULT)


# ── unset semantics ───────────────────────────────────────────────────

@pytest.mark.parametrize("blank", [None, "", "   ", "\t"])
def test_blank_at_a_level_falls_through(blank):
    """A cleared override must not resolve to an empty property name — that
    would render as ``n.`` in Cypher."""
    r = resolve_node_identity(
        data_source=_Level(blank, blank),
        provider=_Level("provId", "provName"),
    )
    assert (r.identity_property, r.identity_source) == ("provId", SOURCE_PROVIDER)
    assert (r.name_property, r.name_source) == ("provName", SOURCE_PROVIDER)


def test_values_are_trimmed():
    r = resolve_node_identity(data_source=_Level("  id  ", "  title  "))
    assert r.identity_property == "id"
    assert r.name_property == "title"


# ── the two properties resolve independently ──────────────────────────

def test_identity_and_name_resolve_from_different_levels():
    """A provider that maps only identity must not drag its display-name
    default over a workspace that explicitly set one."""
    r = resolve_node_identity(
        provider=_Level(identity="id"),
        workspace=_Level(name="title"),
    )
    assert (r.identity_property, r.identity_source) == ("id", SOURCE_PROVIDER)
    assert (r.name_property, r.name_source) == ("title", SOURCE_WORKSPACE)


def test_mapped_flags():
    assert not resolve_node_identity().identity_is_mapped
    assert not resolve_node_identity().name_is_mapped
    r = resolve_node_identity(data_source=_Level("id", "title"))
    assert r.identity_is_mapped and r.name_is_mapped and not r.is_default


# ── provider schemaMapping back-compat ────────────────────────────────

def test_legacy_schema_mapping_is_read_as_the_provider_level():
    prov = ProviderORM(
        id="prov_x", name="p", provider_type="neo4j",
        extra_config=json.dumps(
            {"schemaMapping": {"identity_field": "uuid", "display_name_field": "title"}}
        ),
    )
    assert provider_identity_from_extra_config(prov) == ("uuid", "title")


def test_legacy_schema_mapping_defaults_are_treated_as_unset():
    """Both mechanisms' defaults must fall through, or every existing Neo4j
    provider would suddenly look like it had an explicit mapping."""
    prov = ProviderORM(
        id="prov_x", name="p", provider_type="neo4j",
        extra_config=json.dumps(
            {"schemaMapping": {"identity_field": "urn", "display_name_field": "displayName"}}
        ),
    )
    assert provider_identity_from_extra_config(prov) == (None, None)


@pytest.mark.parametrize("raw", [None, "", "not json", '{"schemaMapping": "nope"}', "[]"])
def test_unreadable_extra_config_is_ignored(raw):
    prov = ProviderORM(id="prov_x", name="p", provider_type="neo4j", extra_config=raw)
    assert provider_identity_from_extra_config(prov) == (None, None)


# ── load_node_identity (walks the real rows) ──────────────────────────

async def _seed(session: AsyncSession, *, prov=None, ws=None, ds=None):
    session.add(ProviderORM(
        id="prov_ni", name="P", provider_type="falkordb", **(prov or {})))
    session.add(WorkspaceORM(id="ws_ni", name="W", **(ws or {})))
    session.add(WorkspaceDataSourceORM(
        id="ds_ni", workspace_id="ws_ni", provider_id="prov_ni",
        graph_name="g", **(ds or {})))
    await session.flush()


@pytest.fixture(autouse=True)
def _clear_defaults_cache():
    invalidate_global_defaults_cache()
    yield
    invalidate_global_defaults_cache()


async def test_load_walks_provider_when_data_source_is_unset(db_session: AsyncSession):
    await _seed(db_session, prov={"identity_property": "id", "name_property": "title"})
    r = await load_node_identity(db_session, "ds_ni")
    assert (r.identity_property, r.identity_source) == ("id", SOURCE_PROVIDER)
    assert (r.name_property, r.name_source) == ("title", SOURCE_PROVIDER)


async def test_load_walks_workspace_when_provider_is_unset(db_session: AsyncSession):
    await _seed(db_session, ws={"identity_property": "_id"})
    r = await load_node_identity(db_session, "ds_ni")
    assert (r.identity_property, r.identity_source) == ("_id", SOURCE_WORKSPACE)


async def test_load_reads_the_platform_row(db_session: AsyncSession):
    await _seed(db_session)
    db_session.add(PlatformSettingsORM(
        id=1, identity_property="identifier", name_property="label"))
    await db_session.flush()
    r = await load_node_identity(db_session, "ds_ni")
    assert (r.identity_property, r.identity_source) == ("identifier", SOURCE_GLOBAL)
    assert (r.name_property, r.name_source) == ("label", SOURCE_GLOBAL)


async def test_load_data_source_overrides_provider(db_session: AsyncSession):
    await _seed(
        db_session,
        prov={"identity_property": "id"},
        ds={"identity_property": "uuid"},
    )
    r = await load_node_identity(db_session, "ds_ni")
    assert (r.identity_property, r.identity_source) == ("uuid", SOURCE_DATA_SOURCE)


async def test_load_uses_provider_legacy_schema_mapping(db_session: AsyncSession):
    await _seed(db_session, prov={"extra_config": json.dumps(
        {"schemaMapping": {"identity_field": "uuid"}})})
    r = await load_node_identity(db_session, "ds_ni")
    assert (r.identity_property, r.identity_source) == ("uuid", SOURCE_PROVIDER)


async def test_load_column_wins_over_legacy_schema_mapping(db_session: AsyncSession):
    await _seed(db_session, prov={
        "identity_property": "id",
        "extra_config": json.dumps({"schemaMapping": {"identity_field": "uuid"}}),
    })
    r = await load_node_identity(db_session, "ds_ni")
    assert r.identity_property == "id"


async def test_load_accepts_an_orm_row(db_session: AsyncSession):
    await _seed(db_session, ds={"identity_property": "id"})
    ds = await db_session.get(WorkspaceDataSourceORM, "ds_ni")
    r = await load_node_identity(db_session, ds)
    assert r.identity_property == "id"


async def test_load_unknown_data_source_returns_defaults(db_session: AsyncSession):
    r = await load_node_identity(db_session, "ds_nope")
    assert r.is_default and r.identity_source == SOURCE_DEFAULT
