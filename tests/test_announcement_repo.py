"""
Unit tests for backend.app.db.repositories.announcement_repo
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import announcement_repo
from backend.common.models.management import (
    AnnouncementCreateRequest,
    AnnouncementUpdateRequest,
    AnnouncementResponse,
    AnnouncementConfigUpdateRequest,
    AnnouncementConfigResponse,
)


# ── helpers ───────────────────────────────────────────────────────────

def _make_create_req(**overrides) -> AnnouncementCreateRequest:
    defaults = dict(
        title="Scheduled Maintenance",
        message="The system will be down for maintenance tonight.",
        banner_type="info",
        is_active=True,
        snooze_duration_minutes=30,
        cta_text="Learn more",
        cta_url="https://example.com/status",
    )
    defaults.update(overrides)
    return AnnouncementCreateRequest(**defaults)


# ── create ────────────────────────────────────────────────────────────

async def test_create_announcement(db_session: AsyncSession):
    req = _make_create_req()
    resp = await announcement_repo.create_announcement(db_session, req, created_by="admin_1")

    assert isinstance(resp, AnnouncementResponse)
    assert resp.id is not None
    assert resp.title == "Scheduled Maintenance"
    assert resp.message == "The system will be down for maintenance tonight."
    assert resp.banner_type == "info"
    assert resp.is_active is True
    assert resp.snooze_duration_minutes == 30
    assert resp.cta_text == "Learn more"
    assert resp.cta_url == "https://example.com/status"
    assert resp.created_by == "admin_1"
    assert resp.created_at is not None


async def test_create_announcement_defaults(db_session: AsyncSession):
    req = AnnouncementCreateRequest(title="Alert", message="Something happened")
    resp = await announcement_repo.create_announcement(db_session, req)

    assert resp.banner_type == "info"
    assert resp.is_active is True
    assert resp.snooze_duration_minutes == 0
    assert resp.cta_text is None
    assert resp.cta_url is None
    assert resp.created_by is None


# ── get ───────────────────────────────────────────────────────────────

async def test_get_announcement_returns_created(db_session: AsyncSession):
    created = await announcement_repo.create_announcement(
        db_session, _make_create_req(title="Get Test")
    )
    fetched = await announcement_repo.get_announcement(db_session, created.id)

    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.title == "Get Test"


async def test_get_announcement_returns_none_for_missing(db_session: AsyncSession):
    result = await announcement_repo.get_announcement(db_session, "ann_nonexistent")
    assert result is None


# ── list ──────────────────────────────────────────────────────────────

async def test_list_announcements(db_session: AsyncSession):
    await announcement_repo.create_announcement(db_session, _make_create_req(title="A"))
    await announcement_repo.create_announcement(db_session, _make_create_req(title="B"))
    await announcement_repo.create_announcement(db_session, _make_create_req(title="C"))

    result = await announcement_repo.list_announcements(db_session)
    assert len(result) == 3
    titles = {a.title for a in result}
    assert titles == {"A", "B", "C"}


async def test_list_announcements_newest_first(db_session: AsyncSession):
    await announcement_repo.create_announcement(db_session, _make_create_req(title="First"))
    await announcement_repo.create_announcement(db_session, _make_create_req(title="Second"))

    result = await announcement_repo.list_announcements(db_session)
    # Newest first
    assert result[0].title == "Second"
    assert result[1].title == "First"


async def test_list_announcements_empty(db_session: AsyncSession):
    result = await announcement_repo.list_announcements(db_session)
    assert result == []


# ── get_active_announcements ─────────────────────────────────────────

async def test_get_active_announcements(db_session: AsyncSession):
    await announcement_repo.create_announcement(
        db_session, _make_create_req(title="Active", is_active=True)
    )
    await announcement_repo.create_announcement(
        db_session, _make_create_req(title="Inactive", is_active=False)
    )

    result = await announcement_repo.get_active_announcements(db_session)
    assert len(result) == 1
    assert result[0].title == "Active"
    assert result[0].is_active is True


async def test_get_active_announcements_empty(db_session: AsyncSession):
    await announcement_repo.create_announcement(
        db_session, _make_create_req(title="Inactive", is_active=False)
    )
    result = await announcement_repo.get_active_announcements(db_session)
    assert result == []


# ── update ────────────────────────────────────────────────────────────

async def test_update_announcement_partial(db_session: AsyncSession):
    created = await announcement_repo.create_announcement(
        db_session, _make_create_req(title="Original")
    )
    update_req = AnnouncementUpdateRequest(title="Updated Title")
    updated = await announcement_repo.update_announcement(
        db_session, created.id, update_req, updated_by="admin_2"
    )

    assert updated is not None
    assert updated.title == "Updated Title"
    assert updated.message == "The system will be down for maintenance tonight."  # unchanged
    assert updated.updated_by == "admin_2"


async def test_update_announcement_all_fields(db_session: AsyncSession):
    created = await announcement_repo.create_announcement(
        db_session, _make_create_req()
    )
    update_req = AnnouncementUpdateRequest(
        title="New Title",
        message="New message",
        banner_type="warning",
        is_active=False,
        snooze_duration_minutes=60,
        cta_text="Click here",
        cta_url="https://new.example.com",
    )
    updated = await announcement_repo.update_announcement(
        db_session, created.id, update_req
    )

    assert updated.title == "New Title"
    assert updated.message == "New message"
    assert updated.banner_type == "warning"
    assert updated.is_active is False
    assert updated.snooze_duration_minutes == 60
    assert updated.cta_text == "Click here"
    assert updated.cta_url == "https://new.example.com"


async def test_update_announcement_returns_none_for_missing(db_session: AsyncSession):
    update_req = AnnouncementUpdateRequest(title="Nope")
    result = await announcement_repo.update_announcement(
        db_session, "ann_missing", update_req
    )
    assert result is None


# ── delete ────────────────────────────────────────────────────────────

async def test_delete_announcement_success(db_session: AsyncSession):
    created = await announcement_repo.create_announcement(
        db_session, _make_create_req()
    )
    deleted = await announcement_repo.delete_announcement(db_session, created.id)
    assert deleted is True

    fetched = await announcement_repo.get_announcement(db_session, created.id)
    assert fetched is None


async def test_delete_announcement_returns_false_for_missing(db_session: AsyncSession):
    result = await announcement_repo.delete_announcement(db_session, "ann_ghost")
    assert result is False


# ── announcement config ──────────────────────────────────────────────

async def test_get_announcement_config_default(db_session: AsyncSession):
    config = await announcement_repo.get_announcement_config(db_session)
    assert isinstance(config, AnnouncementConfigResponse)
    assert config.poll_interval_seconds == 15
    assert config.default_snooze_minutes == 30


async def test_get_announcement_config_seeds_on_first_access(db_session: AsyncSession):
    # First call should seed the row
    config1 = await announcement_repo.get_announcement_config(db_session)
    # Second call should return the same row
    config2 = await announcement_repo.get_announcement_config(db_session)
    assert config1.poll_interval_seconds == config2.poll_interval_seconds


async def test_update_announcement_config(db_session: AsyncSession):
    update_req = AnnouncementConfigUpdateRequest(
        poll_interval_seconds=60,
        default_snooze_minutes=120,
    )
    config = await announcement_repo.update_announcement_config(
        db_session, update_req, updated_by="admin_x"
    )

    assert config.poll_interval_seconds == 60
    assert config.default_snooze_minutes == 120
    assert config.updated_by == "admin_x"
    assert config.updated_at is not None


async def test_update_announcement_config_partial(db_session: AsyncSession):
    # First seed
    await announcement_repo.get_announcement_config(db_session)

    update_req = AnnouncementConfigUpdateRequest(poll_interval_seconds=45)
    config = await announcement_repo.update_announcement_config(db_session, update_req)

    assert config.poll_interval_seconds == 45
    assert config.default_snooze_minutes == 30  # unchanged from default


async def test_update_announcement_config_creates_row_if_missing(db_session: AsyncSession):
    """update should create the row if it doesn't exist yet."""
    update_req = AnnouncementConfigUpdateRequest(poll_interval_seconds=99)
    config = await announcement_repo.update_announcement_config(db_session, update_req)
    assert config.poll_interval_seconds == 99
