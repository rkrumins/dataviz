"""
Unit tests for backend.app.db.repositories.connection_repo
"""
from backend.app.db.repositories import connection_repo
from backend.common.models.management import (
    ConnectionCreateRequest,
    ConnectionUpdateRequest,
    ConnectionCredentials,
    ProviderType,
)


# ── helpers ───────────────────────────────────────────────────────────

def _make_create_req(**overrides) -> ConnectionCreateRequest:
    defaults = dict(
        name="test-connection",
        provider_type=ProviderType.MOCK,
        host="localhost",
        port=6379,
        graph_name="test-graph",
        credentials=ConnectionCredentials(username="user", password="pass"),
        tls_enabled=False,
        extra_config=None,
    )
    defaults.update(overrides)
    return ConnectionCreateRequest(**defaults)


# ── create ────────────────────────────────────────────────────────────

async def test_create_connection_returns_response(db_session):
    req = _make_create_req()
    resp = await connection_repo.create_connection(db_session, req)

    assert resp.id is not None
    assert resp.name == "test-connection"
    assert resp.provider_type == ProviderType.MOCK
    assert resp.host == "localhost"
    assert resp.port == 6379
    assert resp.graph_name == "test-graph"
    assert resp.tls_enabled is False
    assert resp.is_primary is False
    assert resp.is_active is True
    assert resp.created_at is not None


async def test_create_connection_with_make_primary(db_session):
    req = _make_create_req(name="primary-conn")
    resp = await connection_repo.create_connection(db_session, req, make_primary=True)

    assert resp.is_primary is True


# ── get ───────────────────────────────────────────────────────────────

async def test_get_connection_returns_created(db_session):
    req = _make_create_req()
    created = await connection_repo.create_connection(db_session, req)

    fetched = await connection_repo.get_connection(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_connection_returns_none_for_missing(db_session):
    result = await connection_repo.get_connection(db_session, "conn_nonexistent")
    assert result is None


# ── list ──────────────────────────────────────────────────────────────

async def test_list_connections_returns_all(db_session):
    await connection_repo.create_connection(db_session, _make_create_req(name="c1"))
    await connection_repo.create_connection(db_session, _make_create_req(name="c2"))
    await connection_repo.create_connection(db_session, _make_create_req(name="c3"))

    result = await connection_repo.list_connections(db_session)
    assert len(result) == 3
    names = [c.name for c in result]
    assert "c1" in names
    assert "c2" in names
    assert "c3" in names


# ── update ────────────────────────────────────────────────────────────

async def test_update_connection_partial(db_session):
    created = await connection_repo.create_connection(db_session, _make_create_req())
    update_req = ConnectionUpdateRequest(name="renamed", port=9999)

    updated = await connection_repo.update_connection(db_session, created.id, update_req)
    assert updated is not None
    assert updated.name == "renamed"
    assert updated.port == 9999
    # unchanged fields preserved
    assert updated.host == "localhost"
    assert updated.graph_name == "test-graph"


async def test_update_connection_returns_none_for_missing(db_session):
    update_req = ConnectionUpdateRequest(name="nope")
    result = await connection_repo.update_connection(db_session, "conn_missing", update_req)
    assert result is None


# ── delete ────────────────────────────────────────────────────────────

async def test_delete_connection_success(db_session):
    created = await connection_repo.create_connection(db_session, _make_create_req())

    deleted = await connection_repo.delete_connection(db_session, created.id)
    assert deleted is True

    fetched = await connection_repo.get_connection(db_session, created.id)
    assert fetched is None


async def test_delete_connection_returns_false_for_missing(db_session):
    result = await connection_repo.delete_connection(db_session, "conn_ghost")
    assert result is False


# ── set_primary / get_primary ─────────────────────────────────────────

async def test_set_primary_demotes_others(db_session):
    c1 = await connection_repo.create_connection(
        db_session, _make_create_req(name="c1"), make_primary=True
    )
    c2 = await connection_repo.create_connection(
        db_session, _make_create_req(name="c2")
    )

    result = await connection_repo.set_primary(db_session, c2.id)
    assert result is True

    fetched_c1 = await connection_repo.get_connection(db_session, c1.id)
    fetched_c2 = await connection_repo.get_connection(db_session, c2.id)
    assert fetched_c1.is_primary is False
    assert fetched_c2.is_primary is True


async def test_get_primary_connection(db_session):
    await connection_repo.create_connection(
        db_session, _make_create_req(name="not-primary")
    )
    primary = await connection_repo.create_connection(
        db_session, _make_create_req(name="primary"), make_primary=True
    )

    result = await connection_repo.get_primary_connection(db_session)
    assert result is not None
    assert result.id == primary.id


async def test_get_primary_connection_returns_none_when_no_primary(db_session):
    await connection_repo.create_connection(db_session, _make_create_req())
    result = await connection_repo.get_primary_connection(db_session)
    assert result is None


# ── credentials ───────────────────────────────────────────────────────

async def test_get_credentials_plaintext_fallback(db_session):
    """Without CREDENTIAL_ENCRYPTION_KEY, credentials are stored as plaintext JSON."""
    req = _make_create_req(
        credentials=ConnectionCredentials(username="admin", password="secret123")
    )
    created = await connection_repo.create_connection(db_session, req)

    creds = await connection_repo.get_credentials(db_session, created.id)
    assert creds["username"] == "admin"
    assert creds["password"] == "secret123"


async def test_get_credentials_returns_empty_for_missing(db_session):
    creds = await connection_repo.get_credentials(db_session, "conn_nope")
    assert creds == {}
