"""Nothing may sit unrefreshed indefinitely.

Three gaps compounded into "the Data Sources page shows figures from days ago":

* the background sweep skipped unregistered assets entirely;
* it re-enqueued every registered asset every tick regardless of age, so its
  cost scaled with the cache rather than with what had actually aged out;
* the read path deliberately never enqueues for a merely-stale row — correct as
  far as it goes, but with no floor, so a row the sweep was not reaching had
  nothing left to rescue it before the 7-day absolute expiry.

These tests pin the floor and the due-ness filter.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend.app.config import resilience
from backend.insights_service import scheduler


def _iso(age_secs: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=age_secs)).isoformat()


# ── sweep due-ness ───────────────────────────────────────────────────────


def test_a_row_inside_the_fresh_window_is_not_due():
    now = datetime.now(timezone.utc)
    assert scheduler._is_due_for_sweep(_iso(10), now) is False


def test_a_row_past_the_fresh_window_is_due():
    now = datetime.now(timezone.utc)
    assert scheduler._is_due_for_sweep(
        _iso(resilience.DISCOVERY_CACHE_FRESH_SECS + 60), now,
    ) is True


@pytest.mark.parametrize("stamp", [None, "", "not-a-timestamp"])
def test_an_undateable_row_is_due(stamp):
    """A row we cannot date is exactly the row worth re-reading."""
    assert scheduler._is_due_for_sweep(stamp, datetime.now(timezone.utc)) is True


def test_a_naive_stamp_is_read_as_utc_not_crashed_on():
    naive = (datetime.now(timezone.utc) - timedelta(seconds=5)).replace(
        tzinfo=None,
    ).isoformat()
    assert scheduler._is_due_for_sweep(naive, datetime.now(timezone.utc)) is False


def test_the_sweep_covers_unregistered_assets_by_default():
    """The registered-only limit is what left an unregistered asset's row
    untouched until absolute expiry."""
    assert scheduler._SWEEP_REGISTERED_ONLY is False


# ── read-path self-heal floor ────────────────────────────────────────────


class _Row:
    def __init__(self, age_secs):
        self.payload = '{"nodeCount": 5, "edgeCount": 9}'
        self.computed_at = _iso(age_secs)
        self.last_error = None


async def _read(monkeypatch, age_secs):
    from backend.app.api.v1.endpoints import insights

    enqueued = []

    async def fake_enqueue(provider_id, asset_name, priority=False):
        enqueued.append((provider_id, asset_name, priority))
        return "1-0"

    async def fake_read_cache(session, provider_id, asset_name):
        return _Row(age_secs)

    async def fake_health(session, provider_id):
        return "ok"

    async def fake_in_flight(provider_id, asset_name):
        return False

    monkeypatch.setattr(insights, "enqueue_discovery_job_safe", fake_enqueue)
    monkeypatch.setattr(insights, "_read_cache", fake_read_cache)
    monkeypatch.setattr(insights, "_provider_health", fake_health)
    monkeypatch.setattr(insights, "_refresh_in_flight", fake_in_flight)

    env = await insights._build_response(
        session=SimpleNamespace(), provider_id="p1", asset_name="g1",
    )
    return env, enqueued


@pytest.mark.asyncio
async def test_a_merely_stale_row_still_enqueues_nothing(monkeypatch):
    """Rendering a list of stale rows must not manufacture one job per row."""
    age = resilience.DISCOVERY_CACHE_FRESH_SECS + 60
    assert age < resilience.DISCOVERY_CACHE_SELF_HEAL_SECS
    env, enqueued = await _read(monkeypatch, age)
    assert env["meta"]["status"] == "stale"
    assert enqueued == []


@pytest.mark.asyncio
async def test_a_stuck_row_heals_itself_on_read(monkeypatch):
    env, enqueued = await _read(
        monkeypatch, resilience.DISCOVERY_CACHE_SELF_HEAL_SECS + 60,
    )
    assert env["meta"]["status"] == "stale"
    # Served from cache regardless — self-heal must never blank the row.
    assert env["data"]["nodeCount"] == 5
    assert enqueued == [("p1", "g1", False)]   # sweep lane, not the hot lane
    assert env["meta"]["refreshing"] is True
    assert env["meta"]["job_id"] == "1-0"


@pytest.mark.asyncio
async def test_self_heal_can_be_switched_off(monkeypatch):
    """0 disables the floor. The age is kept inside the absolute expiry, past
    which the row is a cache MISS and enqueues on the hot lane regardless —
    that path is older than this floor and unaffected by it."""
    monkeypatch.setattr(resilience, "DISCOVERY_CACHE_SELF_HEAL_SECS", 0)
    age = resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS - 3600
    _, enqueued = await _read(monkeypatch, age)
    assert enqueued == []


@pytest.mark.asyncio
async def test_a_row_past_absolute_expiry_is_still_a_hot_lane_miss(monkeypatch):
    """The floor sits BETWEEN "stale, serve it" and "expired, no longer usable"
    — it must not have moved either boundary."""
    env, enqueued = await _read(
        monkeypatch, resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS + 3600,
    )
    assert env["meta"]["status"] == "computing"
    assert env["data"] is None
    assert enqueued == [("p1", "g1", True)]     # priority: a user is waiting


def test_the_ui_stale_threshold_matches_the_self_heal_floor():
    """The point at which the platform stops calling a row acceptable is the
    honest point to stop painting it green."""
    assert (
        resilience.INSIGHTS_UI_STALE_THRESHOLD_SECS
        == resilience.DISCOVERY_CACHE_SELF_HEAL_SECS
    )
