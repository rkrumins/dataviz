"""The discovery sweep honours each source's configured poll interval.

The Data Sources tab renders ``asset_discovery_cache``, and that cache was
refreshed by a loop that slept ``DISCOVERY_REFRESH_INTERVAL_SECS`` (30 min)
between passes and enqueued every eligible row unconditionally. So a data
source configured to poll every 5 minutes could not be honoured — the loop was
not awake to notice — and a row that had just been refreshed was enqueued again
anyway.

Now the loop ticks on ``DISCOVERY_TICK_INTERVAL_SECS`` and each row carries its
own deadline: the owning data source's ``interval_seconds`` when it has one,
else the global cadence for pre-registration rows that have no data source.
"""
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.config import resilience
from backend.insights_service import scheduler


def _ago(secs: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


# ── the deadline a row inherits ──────────────────────────────────────────


def test_a_configured_source_uses_its_own_interval():
    assert scheduler._discovery_deadline(300, True) == 300


def test_a_row_with_no_data_source_keeps_the_global_cadence():
    assert (
        scheduler._discovery_deadline(None, None)
        == resilience.DISCOVERY_REFRESH_INTERVAL_SECS
    )


def test_a_disabled_polling_config_falls_back_to_the_global_cadence():
    assert (
        scheduler._discovery_deadline(300, False)
        == resilience.DISCOVERY_REFRESH_INTERVAL_SECS
    )


def test_an_interval_below_the_tick_is_floored_at_it():
    """A 1-second interval is not work the loop can do; asking for it must not
    turn every tick into an unconditional re-enqueue."""
    assert (
        scheduler._discovery_deadline(1, True)
        == resilience.DISCOVERY_TICK_INTERVAL_SECS
    )


# ── due-ness ─────────────────────────────────────────────────────────────


def test_a_row_inside_its_deadline_is_not_due():
    now = datetime.now(timezone.utc)
    assert not scheduler._discovery_due(_ago(100), _ago(100), 300, now)


def test_a_row_past_its_deadline_is_due():
    now = datetime.now(timezone.utc)
    assert scheduler._discovery_due(_ago(301), _ago(301), 300, now)


def test_a_short_interval_source_is_due_long_before_the_global_cadence():
    """The whole point: 301s is due at a 300s interval, and would not have been
    reachable at all under the old 1800s loop."""
    now = datetime.now(timezone.utc)
    assert scheduler._discovery_due(
        _ago(301), _ago(301), scheduler._discovery_deadline(300, True), now,
    )
    assert not scheduler._discovery_due(
        _ago(301), _ago(301),
        scheduler._discovery_deadline(None, None), now,
    )


def test_dueness_is_measured_from_the_attempt_not_the_payload():
    """A provider that keeps failing leaves ``computed_at`` frozen. Measuring
    from that would re-enqueue it on every single tick forever."""
    now = datetime.now(timezone.utc)
    assert not scheduler._discovery_due(_ago(10), _ago(99999), 300, now)


def test_a_row_predating_the_attempt_column_falls_back_to_computed_at():
    now = datetime.now(timezone.utc)
    assert not scheduler._discovery_due(None, _ago(10), 300, now)
    assert scheduler._discovery_due(None, _ago(500), 300, now)


def test_a_row_with_no_timestamps_at_all_is_due():
    now = datetime.now(timezone.utc)
    assert scheduler._discovery_due(None, None, 300, now)


def test_an_unparseable_timestamp_is_due():
    now = datetime.now(timezone.utc)
    assert scheduler._discovery_due("not-a-date", None, 300, now)


# ── the tick ─────────────────────────────────────────────────────────────


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Session:
    """Answers the tick's three reads in order: providers, cached rows,
    registered catalog pairs."""

    def __init__(self, *results):
        self._queued = list(results)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, _stmt):
        return _Result(self._queued.pop(0))


@pytest.mark.asyncio
async def test_the_tick_enqueues_only_rows_past_their_own_deadline(monkeypatch):
    enqueued: list[tuple[str, str]] = []

    async def fake_enqueue(provider_id, asset_name=""):
        enqueued.append((provider_id, asset_name))
        return "msg-1"

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_discovery_job_safe", fake_enqueue,
    )
    monkeypatch.setattr(scheduler, "_SWEEP_REGISTERED_ONLY", False)
    monkeypatch.setattr(
        scheduler, "get_readonly_session",
        lambda: _Session(
            [("prov1",)],
            [
                # (provider, asset, computed_at, last_attempt_at, interval, enabled)
                ("prov1", "", _ago(10), _ago(10), None, None),
                # 5-minute source, checked 6 minutes ago → due
                ("prov1", "fast", _ago(360), _ago(360), 300, True),
                # same age, but on the 30-minute default → not due
                ("prov1", "slow", _ago(360), _ago(360), None, None),
            ],
            [],
        ),
    )

    summary = await scheduler._discovery_tick()

    assert enqueued == [("prov1", "fast")]
    assert summary.due == 1
    assert summary.seen == 2          # the sentinel is counted separately
    assert summary.asset_jobs == 1
    assert summary.list_jobs == 0     # the sentinel was refreshed 10s ago


@pytest.mark.asyncio
async def test_the_list_all_sentinel_runs_on_the_global_cadence(monkeypatch):
    enqueued: list[tuple[str, str]] = []

    async def fake_enqueue(provider_id, asset_name=""):
        enqueued.append((provider_id, asset_name))
        return "msg-1"

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_discovery_job_safe", fake_enqueue,
    )
    monkeypatch.setattr(scheduler, "_SWEEP_REGISTERED_ONLY", False)
    overdue = resilience.DISCOVERY_REFRESH_INTERVAL_SECS + 60
    monkeypatch.setattr(
        scheduler, "get_readonly_session",
        lambda: _Session(
            [("prov1",)],
            [("prov1", "", _ago(overdue), _ago(overdue), None, None)],
            [],
        ),
    )

    summary = await scheduler._discovery_tick()

    assert enqueued == [("prov1", "")]
    assert summary.list_jobs == 1


@pytest.mark.asyncio
async def test_a_provider_with_no_sentinel_row_yet_is_due(monkeypatch):
    """First contact: nothing has ever listed this provider's assets."""
    enqueued: list[tuple[str, str]] = []

    async def fake_enqueue(provider_id, asset_name=""):
        enqueued.append((provider_id, asset_name))
        return "msg-1"

    monkeypatch.setattr(
        "backend.insights_service.enqueue.enqueue_discovery_job_safe", fake_enqueue,
    )
    monkeypatch.setattr(scheduler, "_SWEEP_REGISTERED_ONLY", False)
    monkeypatch.setattr(
        scheduler, "get_readonly_session",
        lambda: _Session([("prov1",)], [], []),
    )

    summary = await scheduler._discovery_tick()

    assert enqueued == [("prov1", "")]
    assert summary.list_jobs == 1
