"""
Unit tests for backend.app.db.repositories.provider_repo
"""
from backend.app.db.repositories import provider_repo
from backend.app.db.models import (
    CatalogItemORM,
    WorkspaceORM,
    WorkspaceDataSourceORM,
)
from backend.common.models.management import (
    ProviderCreateRequest,
    ProviderUpdateRequest,
    ConnectionCredentials,
    ProviderType,
)


# ── helpers ───────────────────────────────────────────────────────────

def _make_create_req(**overrides) -> ProviderCreateRequest:
    defaults = dict(
        name="test-provider",
        provider_type=ProviderType.FALKORDB,
        host="localhost",
        port=6379,
        credentials=ConnectionCredentials(username="user", password="pass"),
        tls_enabled=False,
        extra_config=None,
    )
    defaults.update(overrides)
    return ProviderCreateRequest(**defaults)


# ── create ────────────────────────────────────────────────────────────

async def test_create_provider_returns_response(db_session):
    req = _make_create_req()
    resp = await provider_repo.create_provider(db_session, req)

    assert resp.id is not None
    assert resp.name == "test-provider"
    assert resp.provider_type == ProviderType.FALKORDB
    assert resp.host == "localhost"
    assert resp.port == 6379
    assert resp.tls_enabled is False
    assert resp.is_active is True
    assert resp.created_at is not None


# ── get ───────────────────────────────────────────────────────────────

async def test_get_provider_returns_created(db_session):
    created = await provider_repo.create_provider(db_session, _make_create_req())

    fetched = await provider_repo.get_provider(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_provider_returns_none_for_missing(db_session):
    result = await provider_repo.get_provider(db_session, "prov_nonexistent")
    assert result is None


# ── list ──────────────────────────────────────────────────────────────

async def test_list_providers_returns_all(db_session):
    await provider_repo.create_provider(db_session, _make_create_req(name="p1"))
    await provider_repo.create_provider(db_session, _make_create_req(name="p2"))

    result = await provider_repo.list_providers(db_session)
    assert len(result) == 2
    names = {p.name for p in result}
    assert names == {"p1", "p2"}


# ── update ────────────────────────────────────────────────────────────

async def test_update_provider_partial(db_session):
    created = await provider_repo.create_provider(db_session, _make_create_req())
    update_req = ProviderUpdateRequest(name="renamed", port=8888)

    updated = await provider_repo.update_provider(db_session, created.id, update_req)
    assert updated is not None
    assert updated.name == "renamed"
    assert updated.port == 8888
    assert updated.host == "localhost"  # unchanged


async def test_update_provider_returns_none_for_missing(db_session):
    update_req = ProviderUpdateRequest(name="nope")
    result = await provider_repo.update_provider(db_session, "prov_missing", update_req)
    assert result is None


# ── update: credentials three-way semantics ──────────────────────────
# absent / null / object are three distinct intents; the repo must not
# conflate them. Regression guard for the bug where clearing credentials
# from the UI silently kept the old encrypted blob and the next AUTH
# round-trip surfaced ``WRONGPASS``.

async def test_update_credentials_absent_preserves_existing(db_session):
    """``credentials`` field omitted from the patch → no change. Old
    credentials must remain intact (this is what makes "rename only"
    edits safe)."""
    created = await provider_repo.create_provider(
        db_session,
        _make_create_req(credentials=ConnectionCredentials(username="admin", password="secret")),
    )

    # Patch that does NOT mention credentials at all.
    await provider_repo.update_provider(db_session, created.id, ProviderUpdateRequest(name="renamed"))

    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds.get("username") == "admin"
    assert creds.get("password") == "secret"


async def test_update_credentials_null_clears_blob(db_session):
    """``credentials: null`` → explicit clear. Stored blob round-trips
    to an empty mapping so ``creds.get('username')`` and
    ``creds.get('password')`` both return ``None`` and the provider
    constructs a pool without AUTH."""
    created = await provider_repo.create_provider(
        db_session,
        _make_create_req(credentials=ConnectionCredentials(username="admin", password="secret")),
    )

    # The frontend's "Clear stored credentials" toggle sends ``null`` for this
    # field. Pydantic's ``model_fields_set`` lets the repo see this as
    # explicitly-provided-null, distinct from omitted.
    update_req = ProviderUpdateRequest.model_validate({"credentials": None})
    assert "credentials" in update_req.model_fields_set
    assert update_req.credentials is None

    await provider_repo.update_provider(db_session, created.id, update_req)

    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds.get("username") is None
    assert creds.get("password") is None


async def test_update_credentials_replace_overwrites(db_session):
    """New credentials object → replaces the stored blob. Sanity check
    that the third path of the three-way switch still works."""
    created = await provider_repo.create_provider(
        db_session,
        _make_create_req(credentials=ConnectionCredentials(username="old", password="oldpw")),
    )

    update_req = ProviderUpdateRequest(
        credentials=ConnectionCredentials(username="new", password="newpw"),
    )
    await provider_repo.update_provider(db_session, created.id, update_req)

    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds.get("username") == "new"
    assert creds.get("password") == "newpw"


# ── delete ────────────────────────────────────────────────────────────

async def test_delete_provider_success(db_session):
    created = await provider_repo.create_provider(db_session, _make_create_req())

    deleted = await provider_repo.delete_provider(db_session, created.id)
    assert deleted is True

    fetched = await provider_repo.get_provider(db_session, created.id)
    assert fetched is None


async def test_delete_provider_returns_false_for_missing(db_session):
    result = await provider_repo.delete_provider(db_session, "prov_ghost")
    assert result is False


# ── credentials ───────────────────────────────────────────────────────

async def test_get_credentials_plaintext_fallback(db_session):
    req = _make_create_req(
        credentials=ConnectionCredentials(username="admin", password="secret")
    )
    created = await provider_repo.create_provider(db_session, req)

    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds["username"] == "admin"
    assert creds["password"] == "secret"


async def test_get_credentials_returns_empty_for_missing(db_session):
    creds = await provider_repo.get_credentials(db_session, "prov_nope")
    assert creds == {}


# ── has_workspaces ────────────────────────────────────────────────────

async def test_has_workspaces_returns_false_no_data_sources(db_session):
    created = await provider_repo.create_provider(db_session, _make_create_req())
    result = await provider_repo.has_workspaces(db_session, created.id)
    assert result is False


async def test_has_workspaces_returns_true_with_data_sources(db_session):
    """When a workspace data source references a catalog item owned by this provider."""
    created = await provider_repo.create_provider(db_session, _make_create_req())

    # Create a catalog item for this provider
    catalog = CatalogItemORM(
        id="cat_test_hw",
        provider_id=created.id,
        name="test-graph",
        source_identifier="test-graph",
    )
    db_session.add(catalog)
    await db_session.flush()

    # Create a workspace
    ws = WorkspaceORM(id="ws_test_hw", name="Test WS")
    db_session.add(ws)
    await db_session.flush()

    # Create a data source linking workspace to catalog item
    ds = WorkspaceDataSourceORM(
        id="ds_test_hw",
        workspace_id="ws_test_hw",
        provider_id=created.id,
        catalog_item_id="cat_test_hw",
        graph_name="test-graph",
    )
    db_session.add(ds)
    await db_session.flush()

    result = await provider_repo.has_workspaces(db_session, created.id)
    assert result is True
