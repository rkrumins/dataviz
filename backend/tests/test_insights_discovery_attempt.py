"""A failing discovery refresh records the ATTEMPT without faking the payload.

``computed_at`` moves only when a scan produced counts, and ``record_failure``
deliberately leaves it alone — the numbers still being served really are that
old, and advancing the timestamp would be a lie. But nothing recorded the
attempt either, so a provider that had been refusing for days was
indistinguishable from a sweep that had stopped running: the Data Sources tab
showed Tuesday's metrics with no sign anything was still trying.

``last_attempt_at`` is the missing half. It also drives the sweep's due-check,
so a persistently failing asset backs off to its own interval instead of being
re-enqueued on every tick forever.
"""
import contextlib
import json
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AssetDiscoveryCacheORM, ProviderORM
from backend.insights_service import discovery


@pytest.fixture
def _session_bound(monkeypatch, db_session: AsyncSession):
    """Point the handler's short-session helper at the test session."""

    @contextlib.asynccontextmanager
    async def _fake():
        yield db_session

    monkeypatch.setattr(discovery, "get_jobs_session", _fake)


async def _provider(session: AsyncSession) -> str:
    session.add(ProviderORM(
        id="prov1", name="p", provider_type="falkordb",
        host="localhost", port=6379, is_active=True,
    ))
    await session.flush()
    return "prov1"


async def _row(session: AsyncSession, provider_id: str) -> AssetDiscoveryCacheORM:
    return await session.get(AssetDiscoveryCacheORM, (provider_id, "g1"))


@pytest.mark.usefixtures("_session_bound")
async def test_a_successful_refresh_stamps_both_timestamps(db_session: AsyncSession):
    provider_id = await _provider(db_session)
    await discovery._upsert_cache(
        db_session, provider_id=provider_id, asset_name="g1",
        payload={"nodeCount": 5}, status="fresh", last_error=None,
    )
    row = await _row(db_session, provider_id)
    assert row.computed_at and row.last_attempt_at
    assert row.last_attempt_at == row.computed_at


@pytest.mark.usefixtures("_session_bound")
async def test_a_failure_advances_the_attempt_but_not_the_payload(
    db_session: AsyncSession,
):
    provider_id = await _provider(db_session)
    await discovery._upsert_cache(
        db_session, provider_id=provider_id, asset_name="g1",
        payload={"nodeCount": 5}, status="fresh", last_error=None,
    )
    row = await _row(db_session, provider_id)
    computed_before = row.computed_at
    attempt_before = row.last_attempt_at

    await discovery.record_failure(provider_id, "g1", "tcp_refused: localhost:6379")

    row = await _row(db_session, provider_id)
    assert row.computed_at == computed_before, "the counts are still that old"
    assert row.last_attempt_at != attempt_before, "but we did try again"
    assert row.last_error.startswith("tcp_refused")
    # The payload the UI renders is untouched — last known good, not zeroed.
    assert json.loads(row.payload) == {"nodeCount": 5}


@pytest.mark.usefixtures("_session_bound")
async def test_a_failure_with_no_prior_row_still_records_the_attempt(
    db_session: AsyncSession,
):
    """First contact with an unreachable provider: the stub row must not look
    like it has never been tried, or the sweep re-enqueues it every tick."""
    provider_id = await _provider(db_session)
    await discovery.record_failure(provider_id, "g1", "dns_unresolvable: nope")
    row = await _row(db_session, provider_id)
    assert row is not None
    assert row.status == "stale"
    assert row.last_attempt_at is not None
    parsed = datetime.fromisoformat(row.last_attempt_at)
    assert (datetime.now(timezone.utc) - parsed).total_seconds() < 60
