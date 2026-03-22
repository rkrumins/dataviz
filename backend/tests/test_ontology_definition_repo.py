"""
Tests for backend.app.db.repositories.ontology_definition_repo.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import ontology_definition_repo
from backend.common.models.management import (
    OntologyCreateRequest,
    OntologyUpdateRequest,
    OntologyDefinitionResponse,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_create_req(**overrides) -> OntologyCreateRequest:
    defaults = dict(
        name="Test Ontology",
        description="A test ontology",
        entity_type_definitions={"Server": {"label": "Server"}},
        relationship_type_definitions={"HOSTS": {"label": "Hosts"}},
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["DERIVES_FROM"],
        evolution_policy="reject",
        entity_type_hierarchy={},
        root_entity_types=["Server"],
        edge_type_metadata={},
    )
    defaults.update(overrides)
    return OntologyCreateRequest(**defaults)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_create_ontology_returns_response(db_session: AsyncSession):
    req = _make_create_req()
    resp = await ontology_definition_repo.create_ontology(db_session, req)

    assert isinstance(resp, OntologyDefinitionResponse)
    assert resp.name == "Test Ontology"
    assert resp.version == 1
    assert resp.is_published is False
    assert resp.schema_id == resp.id  # first version seeds its own schema_id
    assert "Server" in resp.entity_type_definitions
    assert "HOSTS" in resp.relationship_type_definitions


async def test_get_ontology_returns_created(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    fetched = await ontology_definition_repo.get_ontology(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_ontology_returns_none_for_missing(db_session: AsyncSession):
    result = await ontology_definition_repo.get_ontology(db_session, "nonexistent-id")
    assert result is None


async def test_list_ontologies(db_session: AsyncSession):
    await ontology_definition_repo.create_ontology(
        db_session, _make_create_req(name="Ontology A")
    )
    await ontology_definition_repo.create_ontology(
        db_session, _make_create_req(name="Ontology B")
    )
    results = await ontology_definition_repo.list_ontologies(db_session)
    assert len(results) == 2
    names = {r.name for r in results}
    assert names == {"Ontology A", "Ontology B"}


async def test_update_ontology_modifies_fields(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    update_req = OntologyUpdateRequest(
        name="Updated Name",
        description="Updated description",
    )
    updated = await ontology_definition_repo.update_ontology(
        db_session, created.id, update_req
    )
    assert updated is not None
    assert updated.name == "Updated Name"
    assert updated.description == "Updated description"
    assert updated.id == created.id  # same row (in-place update)


async def test_publish_ontology(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    published = await ontology_definition_repo.publish_ontology(db_session, created.id)
    assert published is not None
    assert published.is_published is True
    assert published.published_at is not None


async def test_update_after_publish_creates_new_version(db_session: AsyncSession):
    """Type definition changes on a published ontology create a new version row."""
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    await ontology_definition_repo.publish_ontology(db_session, created.id)

    update_req = OntologyUpdateRequest(
        entity_type_definitions={"Server": {"label": "Server"}, "Database": {"label": "DB"}},
    )
    new_version = await ontology_definition_repo.update_ontology(
        db_session, created.id, update_req
    )
    assert new_version is not None
    assert new_version.id != created.id  # new row
    assert new_version.version == 2
    assert new_version.schema_id == created.schema_id
    assert new_version.is_published is False
    assert "Database" in new_version.entity_type_definitions


async def test_delete_ontology_soft_deletes(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    result = await ontology_definition_repo.delete_ontology(db_session, created.id)
    assert result is True

    # Soft-deleted: still retrievable via get but has deleted_at set
    fetched = await ontology_definition_repo.get_ontology(db_session, created.id)
    assert fetched is not None
    assert fetched.deleted_at is not None

    # Not listed by default (excludes deleted)
    listed = await ontology_definition_repo.list_ontologies(db_session)
    assert len(listed) == 0

    # Double-delete returns False
    result2 = await ontology_definition_repo.delete_ontology(db_session, created.id)
    assert result2 is False


async def test_restore_ontology(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    await ontology_definition_repo.delete_ontology(db_session, created.id)

    restored = await ontology_definition_repo.restore_ontology(db_session, created.id)
    assert restored is not None
    assert restored.deleted_at is None

    # Now shows up in list again
    listed = await ontology_definition_repo.list_ontologies(db_session)
    assert len(listed) == 1


async def test_list_latest_ontologies(db_session: AsyncSession):
    """list_latest_ontologies returns only the latest version per schema."""
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req(name="Schema X")
    )
    await ontology_definition_repo.publish_ontology(db_session, created.id)

    # Create new version via update on published
    update_req = OntologyUpdateRequest(
        entity_type_definitions={"NewType": {"label": "New"}},
    )
    v2 = await ontology_definition_repo.update_ontology(
        db_session, created.id, update_req
    )

    # Also create a separate ontology
    await ontology_definition_repo.create_ontology(
        db_session, _make_create_req(name="Schema Y")
    )

    latest = await ontology_definition_repo.list_latest_ontologies(db_session)
    assert len(latest) == 2
    names = {r.name for r in latest}
    assert "Schema Y" in names
    # The latest for Schema X should be v2
    schema_x = [r for r in latest if r.schema_id == created.schema_id]
    assert len(schema_x) == 1
    assert schema_x[0].version == v2.version


async def test_list_versions_by_schema(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    await ontology_definition_repo.publish_ontology(db_session, created.id)

    update_req = OntologyUpdateRequest(
        entity_type_definitions={"A": {"label": "A"}},
    )
    await ontology_definition_repo.update_ontology(db_session, created.id, update_req)

    versions = await ontology_definition_repo.list_versions_by_schema(
        db_session, created.schema_id
    )
    assert len(versions) == 2
    assert versions[0].version > versions[1].version  # newest first


async def test_has_data_sources_returns_false_when_none(db_session: AsyncSession):
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    result = await ontology_definition_repo.has_data_sources(db_session, created.id)
    assert result is False


async def test_get_audit_log(db_session: AsyncSession):
    """create + publish should produce audit entries for that schema."""
    created = await ontology_definition_repo.create_ontology(
        db_session, _make_create_req()
    )
    await ontology_definition_repo.publish_ontology(db_session, created.id)

    log = await ontology_definition_repo.get_audit_log(
        db_session, created.schema_id
    )
    assert len(log) >= 2
    actions = [entry.action for entry in log]
    assert "created" in actions
    assert "published" in actions
    # Entries are ordered newest first
    assert log[0].action == "published"
