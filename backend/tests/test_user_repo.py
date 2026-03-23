"""
Unit tests for backend.app.db.repositories.user_repo
"""
from backend.app.db.models import UserORM  # verifies ORM model exists
from backend.app.db.repositories import user_repo


# ── helpers ───────────────────────────────────────────────────────────

async def _create_test_user(session, email="alice@example.com", status="pending"):
    return await user_repo.create_user(
        session,
        email=email,
        password_hash="hashed_pw_123",
        first_name="Alice",
        last_name="Smith",
        status=status,
    )


# ── create ────────────────────────────────────────────────────────────

async def test_create_user_returns_orm(db_session):
    user = await _create_test_user(db_session)

    assert isinstance(user, UserORM)
    assert user.id is not None
    assert user.id.startswith("usr_")
    assert user.first_name == "Alice"
    assert user.last_name == "Smith"
    assert user.status == "pending"
    assert user.created_at is not None


async def test_create_user_normalizes_email(db_session):
    user = await user_repo.create_user(
        db_session,
        email="  BOB@Example.COM  ",
        password_hash="hash",
        first_name="Bob",
        last_name="Jones",
    )
    assert user.email == "bob@example.com"


async def test_create_user_strips_names(db_session):
    user = await user_repo.create_user(
        db_session,
        email="trim@test.com",
        password_hash="hash",
        first_name="  Carol  ",
        last_name="  Davis  ",
    )
    assert user.first_name == "Carol"
    assert user.last_name == "Davis"


# ── get_user_by_email ─────────────────────────────────────────────────

async def test_get_user_by_email_found(db_session):
    created = await _create_test_user(db_session, email="find@test.com")

    found = await user_repo.get_user_by_email(db_session, "find@test.com")
    assert found is not None
    assert found.id == created.id


async def test_get_user_by_email_case_insensitive(db_session):
    await _create_test_user(db_session, email="case@test.com")

    found = await user_repo.get_user_by_email(db_session, "CASE@TEST.COM")
    assert found is not None
    assert found.email == "case@test.com"


async def test_get_user_by_email_returns_none_for_missing(db_session):
    result = await user_repo.get_user_by_email(db_session, "nobody@test.com")
    assert result is None


# ── get_user_by_id ────────────────────────────────────────────────────

async def test_get_user_by_id_found(db_session):
    created = await _create_test_user(db_session, email="byid@test.com")

    found = await user_repo.get_user_by_id(db_session, created.id)
    assert found is not None
    assert found.email == "byid@test.com"


async def test_get_user_by_id_returns_none_for_missing(db_session):
    result = await user_repo.get_user_by_id(db_session, "usr_doesnotexist")
    assert result is None


# ── list_users ────────────────────────────────────────────────────────

async def test_list_users_returns_all(db_session):
    await _create_test_user(db_session, email="u1@test.com")
    await _create_test_user(db_session, email="u2@test.com")
    await _create_test_user(db_session, email="u3@test.com")

    users = await user_repo.list_users(db_session)
    assert len(users) == 3


async def test_list_users_with_status_filter(db_session):
    await _create_test_user(db_session, email="active1@test.com", status="active")
    await _create_test_user(db_session, email="pending1@test.com", status="pending")
    await _create_test_user(db_session, email="active2@test.com", status="active")

    active_users = await user_repo.list_users(db_session, status="active")
    assert len(active_users) == 2
    assert all(u.status == "active" for u in active_users)


async def test_list_users_limit_offset(db_session):
    for i in range(5):
        await _create_test_user(db_session, email=f"page{i}@test.com")

    page = await user_repo.list_users(db_session, limit=2, offset=0)
    assert len(page) == 2

    page2 = await user_repo.list_users(db_session, limit=2, offset=2)
    assert len(page2) == 2

    # No overlap
    ids_page1 = {u.id for u in page}
    ids_page2 = {u.id for u in page2}
    assert ids_page1.isdisjoint(ids_page2)


# ── count_users ───────────────────────────────────────────────────────

async def test_count_users_total(db_session):
    await _create_test_user(db_session, email="c1@test.com")
    await _create_test_user(db_session, email="c2@test.com")

    count = await user_repo.count_users(db_session)
    assert count == 2


async def test_count_users_with_status(db_session):
    await _create_test_user(db_session, email="ca@test.com", status="active")
    await _create_test_user(db_session, email="cp@test.com", status="pending")
    await _create_test_user(db_session, email="ca2@test.com", status="active")

    assert await user_repo.count_users(db_session, status="active") == 2
    assert await user_repo.count_users(db_session, status="pending") == 1
    assert await user_repo.count_users(db_session, status="suspended") == 0


# ── update_user_status ────────────────────────────────────────────────

async def test_update_user_status(db_session):
    user = await _create_test_user(db_session, email="status@test.com", status="pending")

    updated = await user_repo.update_user_status(db_session, user.id, "active")
    assert updated is not None
    assert updated.status == "active"


async def test_update_user_status_returns_none_for_missing(db_session):
    result = await user_repo.update_user_status(db_session, "usr_nope", "active")
    assert result is None


# ── roles ─────────────────────────────────────────────────────────────

async def test_assign_role_and_get_roles(db_session):
    user = await _create_test_user(db_session, email="roles@test.com")

    role = await user_repo.assign_role(db_session, user.id, "admin")
    assert role.role_name == "admin"
    assert role.user_id == user.id

    roles = await user_repo.get_user_roles(db_session, user.id)
    assert "admin" in roles


async def test_get_user_roles_empty(db_session):
    user = await _create_test_user(db_session, email="noroles@test.com")
    roles = await user_repo.get_user_roles(db_session, user.id)
    assert roles == []


async def test_assign_multiple_roles(db_session):
    user = await _create_test_user(db_session, email="multi@test.com")

    await user_repo.assign_role(db_session, user.id, "admin")
    await user_repo.assign_role(db_session, user.id, "user")

    roles = await user_repo.get_user_roles(db_session, user.id)
    assert set(roles) == {"admin", "user"}


# ── password management ──────────────────────────────────────────────

async def test_update_password_clears_reset_token(db_session):
    user = await _create_test_user(db_session, email="pwreset@test.com", status="active")

    # Create a reset token first
    raw_token, expires_at = await user_repo.create_reset_token(db_session, user.id)
    assert raw_token is not None
    assert expires_at is not None

    # Verify the token is set
    refreshed = await user_repo.get_user_by_id(db_session, user.id)
    assert refreshed.reset_token_hash is not None

    # Update password (should clear reset token)
    updated = await user_repo.update_password(db_session, user.id, "new_hash_456")
    assert updated is not None
    assert updated.password_hash == "new_hash_456"
    assert updated.reset_token_hash is None
    assert updated.reset_token_expires_at is None


async def test_update_password_returns_none_for_missing(db_session):
    result = await user_repo.update_password(db_session, "usr_ghost", "newhash")
    assert result is None


# ── reset tokens ──────────────────────────────────────────────────────

async def test_create_reset_token(db_session):
    user = await _create_test_user(db_session, email="token@test.com", status="active")

    raw_token, expires_at = await user_repo.create_reset_token(db_session, user.id)
    assert isinstance(raw_token, str)
    assert len(raw_token) > 20
    assert expires_at is not None


async def test_verify_reset_token_valid(db_session):
    user = await _create_test_user(db_session, email="verify@test.com", status="active")
    raw_token, _ = await user_repo.create_reset_token(db_session, user.id)

    found = await user_repo.verify_reset_token(db_session, raw_token)
    assert found is not None
    assert found.id == user.id


async def test_verify_reset_token_invalid(db_session):
    result = await user_repo.verify_reset_token(db_session, "bogus-token-value")
    assert result is None


async def test_clear_reset_token(db_session):
    user = await _create_test_user(db_session, email="clear@test.com", status="active")
    raw_token, _ = await user_repo.create_reset_token(db_session, user.id)

    await user_repo.clear_reset_token(db_session, user.id)

    # Token should no longer verify
    result = await user_repo.verify_reset_token(db_session, raw_token)
    assert result is None

    # User fields should be cleared
    refreshed = await user_repo.get_user_by_id(db_session, user.id)
    assert refreshed.reset_token_hash is None
    assert refreshed.reset_token_expires_at is None
