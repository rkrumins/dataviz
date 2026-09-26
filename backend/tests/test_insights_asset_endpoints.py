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


def _row(age_secs: int) -> SimpleNamespace:
    computed = datetime.now(timezone.utc) - timedelta(seconds=age_secs)
    return SimpleNamespace(
        payload=json.dumps({"assets": ["a"]}),
        computed_at=computed.isoformat(),
        last_error=None,
    )


class _Session:
    """session.get fake: health window → None, cache row → self._row."""

    def __init__(self, row):
        self._row = row

    async def get(self, orm, _key):
        if orm is ProviderHealthWindowORM:
            return None
        return self._row


def _wire_safe_enqueue(
    monkeypatch, *, claim_held: bool = False, enqueue_returns: str | None = "1-1",
) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []

    async def fake_safe(provider_id, asset_name, **_kw):
        calls.append((provider_id, asset_name))
        return enqueue_returns

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



class _TwoReadSession:
    """``refresh_all_assets`` reads twice: the inventory sentinel's payload,
    then the capped per-asset names. ``listed`` is what the provider
    currently has; ``cached`` is what has a stats row."""

    def __init__(self, listed=None, cached=()):
        self.listed = listed
        self.cached = list(cached)
        self.statements: list[str] = []
        self._n = 0

    async def execute(self, stmt):
        self.statements.append(str(stmt))
        self._n += 1
        if self._n == 1:
            payload = (
                json.dumps({"assets": list(self.listed)})
                if self.listed is not None else None
            )
            return _ScalarResult(payload)
        return _NameRows(self.cached)


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return self

    def first(self):
        return self._value


class _NameRows:
    def __init__(self, names):
        self._names = names

    def all(self):
        return [(n,) for n in self._names]


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

    body = insights.ProviderRefreshRequest(asset_names=["g2", "not_a_real_asset"])
    res = await insights.refresh_all_assets(
        provider_id="p1", body=body,
        session=_TwoReadSession(listed=["g1", "g2", "g3"], cached=["g1", "g2", "g3"]),
    )

    # List sentinel always runs (discovers new/removed assets); the
    # per-asset fan-out is requested ∩ known only — arbitrary names
    # can't seed stub cache rows, and nothing beyond the view refreshes.
    assert forced == ["", "g2"]
    assert res["jobs_queued"] == 1     # assets only; the sentinel is not a source

    # Legacy no-body call keeps refresh-everything behavior.
    forced.clear()
    res = await insights.refresh_all_assets(
        provider_id="p1", body=None,
        session=_TwoReadSession(listed=["g1", "g2", "g3"], cached=["g1", "g2", "g3"]),
    )
    assert forced == ["", "g1", "g2", "g3"]
    assert res["jobs_queued"] == 3


@pytest.mark.asyncio
async def test_the_list_sentinel_is_not_a_data_source(monkeypatch) -> None:
    """``jobs_queued`` counts ASSETS. The empty-string row is the
    provider's list-all inventory job, and the UI renders this number
    verbatim as "Refreshing all N sources" — so counting it made every
    refresh report one more source than the tab lists (the reported
    "129 data sources but only 128 appear").

    It must also not spend a slot of the LIMIT: filtered after the query,
    a provider at the cap returns cap-1 assets and ``truncated`` can never
    be true."""
    forced: list[str] = []

    async def fake_force(provider_id, asset_name=""):
        forced.append(asset_name)
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_force", fake_force)

    async def no_check(_session, _provider_id):
        return None

    monkeypatch.setattr(insights, "_ensure_provider_exists", no_check)

    # g3 is on the provider but has no stats row yet — the just-discovered
    # case, and the whole point: a refresh must cover it.
    session = _TwoReadSession(listed=["g1", "g2", "g3"], cached=["g1", "g2"])
    res = await insights.refresh_all_assets(
        provider_id="p1", body=None, session=session,
    )

    # THREE assets: the newly listed g3 is refreshed even though nothing has
    # ever cached it. Before this, the fan-out was built from cache rows
    # alone and g3 was skipped on every click.
    assert sorted(n for n in forced if n) == ["g1", "g2", "g3"]
    assert res["jobs_queued"] == 3
    assert res["list_job_id"] == "1-1"     # sentinel enqueued, still reported

    # ... and it is not counted as a source: three assets, not four.
    assert "" in forced

    # The names read excludes the sentinel in SQL, so it cannot spend one of
    # the capped slots; the inventory comes from its own single-row read.
    assert 'asset_name != ' in session.statements[1]
    assert 'asset_name = ' in session.statements[0]


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

    names = [f"g{i}" for i in range(10)]

    res = await insights.refresh_all_assets(
        provider_id="p1", body=None,
        session=_TwoReadSession(listed=names, cached=names),
    )

    assert res["jobs_queued"] == 10        # 10 assets (the sentinel is not one)
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

    res = await insights.refresh_all_assets(
        provider_id="p1", body=None,
        session=_TwoReadSession(listed=["g1", "g2"], cached=["g1", "g2"]),
    )
    assert isinstance(res, dict)
    assert res["jobs_queued"] == 0     # degraded: nothing queued, but no 503
    assert res["list_job_id"] is None


@pytest.mark.asyncio
async def test_a_deduped_enqueue_on_a_cold_cache_is_computing_not_unavailable(
    monkeypatch,
) -> None:
    """``enqueue_discovery_job_safe`` returns None for TWO reasons: Redis is
    down, and a job for this scope is ALREADY CLAIMED. Only the first is
    ``unavailable``.

    Reading the second as unavailable stopped the UI polling dead on exactly
    the case where work was in flight — a provider whose inventory has never
    been cached and whose discovery job is already running. assetListState
    maps 'unavailable' to a terminal empty state and assetListIsBuilding
    returns false, so nothing re-fetched and a newly created graph was never
    seen without a reload."""
    _wire_safe_enqueue(monkeypatch, claim_held=True, enqueue_returns=None)

    env = await insights._build_response(
        session=_Session(None), provider_id="p1", asset_name="",
    )

    assert env["meta"]["status"] == "computing"
    assert env["meta"]["refreshing"] is True
    # No job id to poll — the claim belongs to the job already running.
    assert env["meta"]["job_id"] is None


@pytest.mark.asyncio
async def test_redis_down_on_a_cold_cache_is_still_unavailable(monkeypatch) -> None:
    """The other half of the same branch: nothing is claimed and nothing
    could be queued, so the honest answer is still ``unavailable``. A
    spinner here would never stop."""
    _wire_safe_enqueue(monkeypatch, claim_held=False, enqueue_returns=None)

    env = await insights._build_response(
        session=_Session(None), provider_id="p1", asset_name="",
    )

    assert env["meta"]["status"] == "unavailable"
    assert env["meta"]["refreshing"] is False


@pytest.mark.asyncio
async def test_a_deleted_graph_is_not_refreshed_back_into_existence(
    monkeypatch,
) -> None:
    """A cached name the inventory no longer lists is a graph the user
    DELETED. Nothing prunes per-asset rows, so they accumulate forever — and
    every job queued for one re-touched the graph key. Refresh must fan out
    over what the provider HAS, not over what it once had."""
    forced: list[str] = []

    async def fake_force(provider_id, asset_name=""):
        forced.append(asset_name)
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_force", fake_force)

    async def no_check(_session, _provider_id):
        return None

    monkeypatch.setattr(insights, "_ensure_provider_exists", no_check)

    # g2 was deleted on the provider; its stats row is still here.
    res = await insights.refresh_all_assets(
        provider_id="p1", body=None,
        session=_TwoReadSession(listed=["g1", "g3"], cached=["g1", "g2"]),
    )

    assert "g2" not in forced
    assert sorted(n for n in forced if n) == ["g1", "g3"]
    assert res["jobs_queued"] == 2


@pytest.mark.asyncio
async def test_without_an_inventory_the_cached_rows_are_all_we_know(
    monkeypatch,
) -> None:
    """An EMPTY sentinel means "never listed", not "the provider has
    nothing" — so the filter must not fire and strand every asset."""
    forced: list[str] = []

    async def fake_force(provider_id, asset_name=""):
        forced.append(asset_name)
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_discovery_job_force", fake_force)

    async def no_check(_session, _provider_id):
        return None

    monkeypatch.setattr(insights, "_ensure_provider_exists", no_check)

    res = await insights.refresh_all_assets(
        provider_id="p1", body=None,
        session=_TwoReadSession(listed=None, cached=["g1", "g2"]),
    )

    assert sorted(n for n in forced if n) == ["g1", "g2"]
    assert res["jobs_queued"] == 2
