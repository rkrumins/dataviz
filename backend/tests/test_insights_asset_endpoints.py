"""Discovery asset endpoints: reads must be PURE (no enqueue side
effect for merely-stale rows — the old behavior meant rendering an
asset list manufactured one discovery job per visible row), and the
provider-level refresh must scope its per-asset fan-out to the
requested names instead of force-refreshing all ≤200 cached assets.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import insights
from backend.app.config import resilience
from backend.app.db.models import ProviderHealthWindowORM
from backend.insights_service import enqueue as enqueue_mod


def _row(age_secs: int, attempt_age_secs: int | None = None) -> SimpleNamespace:
    now = datetime.now(timezone.utc)
    computed = now - timedelta(seconds=age_secs)
    attempted = (
        now - timedelta(seconds=attempt_age_secs)
        if attempt_age_secs is not None else computed
    )
    return SimpleNamespace(
        payload=json.dumps({"assets": ["a"]}),
        computed_at=computed.isoformat(),
        last_error=None,
        last_attempt_at=attempted.isoformat(),
    )


class _Session:
    """session.get fake: health window → None, cache row → self._row.

    ``execute`` answers the stale path's polling-config lookup with "no
    configured interval", so the row falls back to the global sweep deadline.
    """

    def __init__(self, row):
        self._row = row

    async def get(self, orm, _key):
        if orm is ProviderHealthWindowORM:
            return None
        return self._row

    async def execute(self, _stmt):
        return SimpleNamespace(first=lambda: None)


def _wire_safe_enqueue(monkeypatch, *, claim_held: bool = False) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []

    async def fake_safe(provider_id, asset_name, **_kw):
        calls.append((provider_id, asset_name))
        return "1-1"

    async def fake_claim_exists(_scope_key, **_kw):
        return claim_held

    monkeypatch.setattr(insights, "enqueue_discovery_job_safe", fake_safe)
    monkeypatch.setattr(insights, "claim_exists", fake_claim_exists)
    return calls


@pytest.mark.asyncio
async def test_stale_read_serves_cache_without_enqueue(monkeypatch) -> None:
    calls = _wire_safe_enqueue(monkeypatch)

    stale_age = resilience.DISCOVERY_CACHE_FRESH_SECS + 60
    env = await insights._build_response(
        session=_Session(_row(stale_age)), provider_id="p1", asset_name="g1",
    )

    assert env["meta"]["status"] == "stale"
    assert env["meta"]["refreshing"] is False
    assert env["meta"]["job_id"] is None
    assert env["data"] is not None  # cache served verbatim
    assert calls == []  # THE fix: a read never generates provider work


@pytest.mark.asyncio
async def test_fresh_window_matches_sweep_cadence(monkeypatch) -> None:
    calls = _wire_safe_enqueue(monkeypatch)

    # Older than the OLD 5-min window but inside the sweep cadence —
    # must now read as fresh (the permanent-stale storm regression).
    age = min(600, resilience.DISCOVERY_CACHE_FRESH_SECS - 1)
    env = await insights._build_response(
        session=_Session(_row(age)), provider_id="p1", asset_name="g1",
    )
    assert env["meta"]["status"] == "fresh"
    assert calls == []


@pytest.mark.asyncio
async def test_true_miss_still_enqueues_once(monkeypatch) -> None:
    calls = _wire_safe_enqueue(monkeypatch)

    env = await insights._build_response(
        session=_Session(None), provider_id="p1", asset_name="g1",
    )
    assert env["meta"]["status"] == "computing"
    assert env["meta"]["refreshing"] is True
    assert calls == [("p1", "g1")]  # first-ever view self-heals


@pytest.mark.asyncio
async def test_pending_job_claim_drives_refreshing_signal(monkeypatch) -> None:
    """After a user clicks refresh (or the sweep enqueues), the dedup
    claim is held — reads must report ``refreshing=true`` so the UI can
    spin-and-poll until the job completes, WITHOUT any enqueue side
    effect of their own."""
    calls = _wire_safe_enqueue(monkeypatch, claim_held=True)

    stale_age = resilience.DISCOVERY_CACHE_FRESH_SECS + 60
    env = await insights._build_response(
        session=_Session(_row(stale_age)), provider_id="p1", asset_name="g1",
    )
    assert env["meta"]["refreshing"] is True
    assert calls == []  # signal only — still no enqueue-on-read

    fresh_env = await insights._build_response(
        session=_Session(_row(10)), provider_id="p1", asset_name="g1",
    )
    assert fresh_env["meta"]["status"] == "fresh"
    assert fresh_env["meta"]["refreshing"] is True  # forced refresh of a fresh row


@pytest.mark.asyncio
async def test_user_discovery_rides_hot_stream(monkeypatch) -> None:
    """User-initiated discovery (priority=True) must land on the hot
    stream (fast worker lane); the background sweep's default stays on
    the sweep stream — so a refresh click never queues behind the
    twice-hourly sweep batch."""
    from backend.insights_service import enqueue as enqueue_mod
    from backend.insights_service.redis_streams import (
        DISCOVERY_HOT_STREAM, DISCOVERY_STREAM,
    )

    used_streams: list[str] = []

    async def fake_enqueue_job_safe(envelope, *, dedup_ttl_secs, stream=None):
        used_streams.append((stream or DISCOVERY_STREAM).stream)
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_job_safe", fake_enqueue_job_safe)

    await enqueue_mod.enqueue_discovery_job_safe("p1", "g1", priority=True)
    await enqueue_mod.enqueue_discovery_job_safe("p1", "g1")  # sweep default
    assert used_streams == [DISCOVERY_HOT_STREAM.stream, DISCOVERY_STREAM.stream]
    # Both share one dedup namespace — a scope can never be queued twice.
    assert DISCOVERY_HOT_STREAM.dedup_prefix == DISCOVERY_STREAM.dedup_prefix
    assert DISCOVERY_HOT_STREAM.lane == "fast"
    assert DISCOVERY_STREAM.lane == "sweep"


@pytest.mark.asyncio
async def test_refresh_scopes_fanout_to_requested_assets(monkeypatch) -> None:
    forced: list[str] = []

    async def fake_force(provider_id, asset_name=""):
        forced.append(asset_name)
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_force", fake_force)

    async def no_check(_session, _provider_id):
        return None

    monkeypatch.setattr(insights, "_ensure_provider_exists", no_check)

    class _Rows:
        def all(self):
            return [("g1",), ("g2",), ("g3",)]

    class _S:
        async def execute(self, _stmt):
            return _Rows()

    body = insights.ProviderRefreshRequest(asset_names=["g2", "not_cached"])
    res = await insights.refresh_all_assets(
        provider_id="p1", body=body, session=_S(),
    )

    # List sentinel always runs (discovers new/removed assets); the
    # per-asset fan-out is requested ∩ cached only — arbitrary names
    # can't seed stub cache rows, and nothing beyond the view refreshes.
    assert forced == ["", "g2"]
    assert res["jobs_queued"] == 2

    # Legacy no-body call keeps refresh-everything behavior.
    forced.clear()
    res = await insights.refresh_all_assets(
        provider_id="p1", body=None, session=_S(),
    )
    assert forced == ["", "g1", "g2", "g3"]
    assert res["jobs_queued"] == 4


@pytest.mark.asyncio
async def test_refresh_bounds_enqueue_concurrency(monkeypatch) -> None:
    """The per-asset fan-out must be microbatched at
    ``INSIGHTS_REFRESH_ENQUEUE_CONCURRENCY`` — a click can't fire an
    unbounded ~200-wide burst that holds a WEB session hostage."""
    monkeypatch.setattr(resilience, "INSIGHTS_REFRESH_ENQUEUE_CONCURRENCY", 3)

    active = 0
    peak = 0

    async def fake_force(provider_id, asset_name=""):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)  # hold the slot so concurrency can build
            return "1-1"
        finally:
            active -= 1

    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_force", fake_force)

    async def no_check(_session, _provider_id):
        return None

    monkeypatch.setattr(insights, "_ensure_provider_exists", no_check)

    names = [(f"g{i}",) for i in range(10)]

    class _Rows:
        def all(self):
            return names

    class _S:
        async def execute(self, _stmt):
            return _Rows()

    res = await insights.refresh_all_assets(provider_id="p1", body=None, session=_S())

    assert res["jobs_queued"] == 11        # list sentinel + 10 assets
    assert peak <= 3                       # never exceeds the cap
    assert peak > 1                        # ... but genuinely runs concurrently


@pytest.mark.asyncio
async def test_force_enqueue_survives_release_claim_redis_error(monkeypatch) -> None:
    """A Redis blip on the (non-safe) ``release_claim`` must not raise out
    of the force-enqueue — that would surface as a misleading
    DB_UNAVAILABLE 503. It degrades to the Redis-tolerant enqueue below."""
    async def boom_release(_scope_key, **_kw):
        raise ConnectionError("redis down")

    async def down_enqueue_safe(_provider_id, _asset_name, **_kw):
        return None  # Redis fully down: the tolerant enqueue lands nothing

    monkeypatch.setattr(enqueue_mod, "release_claim", boom_release)
    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_safe", down_enqueue_safe)

    # Must NOT raise; returns None (nothing queued) rather than a 503.
    assert await enqueue_mod.enqueue_discovery_job_force("p1", "g1") is None


@pytest.mark.asyncio
async def test_refresh_survives_redis_down_without_503(monkeypatch) -> None:
    """End-to-end: when Redis is unreachable, the refresh endpoint returns
    a 202 dict with a degraded ``jobs_queued`` instead of raising."""
    async def boom_release(_scope_key, **_kw):
        raise ConnectionError("redis down")

    async def down_enqueue_safe(_provider_id, _asset_name, **_kw):
        return None

    monkeypatch.setattr(enqueue_mod, "release_claim", boom_release)
    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_safe", down_enqueue_safe)

    async def no_check(_session, _provider_id):
        return None

    monkeypatch.setattr(insights, "_ensure_provider_exists", no_check)

    class _Rows:
        def all(self):
            return [("g1",), ("g2",)]

    class _S:
        async def execute(self, _stmt):
            return _Rows()

    res = await insights.refresh_all_assets(provider_id="p1", body=None, session=_S())
    assert isinstance(res, dict)
    assert res["jobs_queued"] == 0     # degraded: nothing queued, but no 503
    assert res["list_job_id"] is None


# ── read-path repair for a row the sweep has stopped reaching ────────────
#
# Reads must not generate unbounded provider work (the removed enqueue-on-read
# made one job per visible row on every 5s poll). These pin the three things
# that keep the one exception bounded: it needs several MISSED ATTEMPTS, not
# mere staleness; it is capped by a per-scope cooldown; and it never rides the
# hot lane.


class _CooldownRedis:
    """SET NX + EX, in memory. Records what was asked for."""

    def __init__(self):
        self.keys: dict = {}
        self.ttls: list[int] = []

    async def set(self, key, _value, nx=False, ex=None):
        if nx and key in self.keys:
            return None
        self.keys[key] = "1"
        self.ttls.append(ex)
        return True


def _wire_cooldown(monkeypatch) -> _CooldownRedis:
    redis = _CooldownRedis()
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: redis,
    )
    return redis


@pytest.mark.asyncio
async def test_a_merely_stale_row_is_not_repaired_on_read(monkeypatch) -> None:
    """Stale is normal between sweeps. Only a row nothing has ATTEMPTED for
    several of its own deadlines says the sweep is not reaching it."""
    calls = _wire_safe_enqueue(monkeypatch)
    _wire_cooldown(monkeypatch)

    barely_overdue = resilience.DISCOVERY_REFRESH_INTERVAL_SECS * 2
    env = await insights._build_response(
        session=_Session(_row(barely_overdue)), provider_id="p1", asset_name="g1",
    )
    assert env["meta"]["status"] == "stale"
    assert calls == []


@pytest.mark.asyncio
async def test_a_row_the_sweep_stopped_reaching_is_repaired_once(monkeypatch) -> None:
    calls = _wire_safe_enqueue(monkeypatch)
    redis = _wire_cooldown(monkeypatch)

    abandoned = resilience.DISCOVERY_REFRESH_INTERVAL_SECS * 4
    session = _Session(_row(abandoned))

    env = await insights._build_response(
        session=session, provider_id="p1", asset_name="g1",
    )
    assert calls == [("p1", "g1")]
    assert env["meta"]["refreshing"] is True
    # Background repair, not work the reader asked for: no job to poll.
    assert env["meta"]["job_id"] is None
    assert env["meta"]["status"] == "stale"

    # Every subsequent read inside the cooldown is free.
    for _ in range(5):
        await insights._build_response(
            session=session, provider_id="p1", asset_name="g1",
        )
    assert calls == [("p1", "g1")]
    assert list(redis.keys) == ["insights:discovery:readheal:p1:g1"]


@pytest.mark.asyncio
async def test_repair_rides_the_sweep_lane_not_the_hot_lane(monkeypatch) -> None:
    """The hot lane belongs to people clicking Refresh; a wall of abandoned
    rows must never queue ahead of them."""
    seen: list[dict] = []

    async def fake_safe(provider_id, asset_name, **kw):
        seen.append(kw)
        return "1-1"

    async def fake_claim_exists(_scope_key, **_kw):
        return False

    monkeypatch.setattr(insights, "enqueue_discovery_job_safe", fake_safe)
    monkeypatch.setattr(insights, "claim_exists", fake_claim_exists)
    _wire_cooldown(monkeypatch)

    abandoned = resilience.DISCOVERY_REFRESH_INTERVAL_SECS * 4
    await insights._build_response(
        session=_Session(_row(abandoned)), provider_id="p1", asset_name="g1",
    )
    assert seen == [{}], "no priority=True — that is the user-action lane"


@pytest.mark.asyncio
async def test_a_provider_being_retried_and_failing_is_not_piled_on(
    monkeypatch,
) -> None:
    """``computed_at`` is ancient because the provider keeps refusing, but the
    sweep IS reaching it — another job would just fail too."""
    calls = _wire_safe_enqueue(monkeypatch)
    _wire_cooldown(monkeypatch)

    row = _row(
        resilience.DISCOVERY_REFRESH_INTERVAL_SECS * 10,   # payload is days old
        attempt_age_secs=60,                              # but we tried a minute ago
    )
    await insights._build_response(
        session=_Session(row), provider_id="p1", asset_name="g1",
    )
    assert calls == []


@pytest.mark.asyncio
async def test_read_repair_can_be_switched_off(monkeypatch) -> None:
    calls = _wire_safe_enqueue(monkeypatch)
    _wire_cooldown(monkeypatch)
    monkeypatch.setattr(resilience, "DISCOVERY_READ_HEAL_FACTOR", 0)

    abandoned = resilience.DISCOVERY_REFRESH_INTERVAL_SECS * 4
    await insights._build_response(
        session=_Session(_row(abandoned)), provider_id="p1", asset_name="g1",
    )
    assert calls == []


@pytest.mark.asyncio
async def test_a_redis_outage_degrades_to_no_repair(monkeypatch) -> None:
    """A cooldown we cannot take is a repair we do not attempt — never a
    failed read."""
    calls = _wire_safe_enqueue(monkeypatch)

    class _DeadRedis:
        async def set(self, *_a, **_kw):
            raise ConnectionError("redis down")

    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: _DeadRedis(),
    )

    abandoned = resilience.DISCOVERY_REFRESH_INTERVAL_SECS * 4
    env = await insights._build_response(
        session=_Session(_row(abandoned)), provider_id="p1", asset_name="g1",
    )
    assert calls == []
    assert env["meta"]["status"] == "stale"
