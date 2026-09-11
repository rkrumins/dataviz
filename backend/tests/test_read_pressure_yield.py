"""
Interactive reads come first.

Aggregation jobs and interactive users share one FalkorDB, and the writers'
only feedback used to be their OWN write latency: a job issuing small, fast
MERGE batches while the canvas's reads queued behind them looked healthy and
never yielded. These tests pin the cross-tier signal that fixes that:

  1. The breaker proxy publishes a capacity signal — queue-full, server-side
     timeout, client deadline — to registered listeners, and a listener can
     never fail the request. A rejected query or a network error publishes
     nothing.
  2. The web-tier listener stamps ``agg:readpressure:{endpoint}`` with a TTL,
     coalesces a storm into one write, and fails open when Redis is down.
  3. The admission controller reads the key, memoises the verdict, and fails
     open to "no pressure".
  4. The materializer's pacing loop sleeps at the read-pressure ratio while
     the key lives and returns to the base ratio when it clears — and is
     unchanged for an admission controller without the check.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.providers import falkordb_materialize as mat
from backend.app.services.aggregation import admission as adm
from backend.app.services.aggregation import read_pressure as rp
from backend.common.adapters import (
    CircuitBreakerProxy,
    ProviderBusy,
    ProviderTimeout,
    ProviderUnavailable,
)
from backend.common.adapters import circuit


class _Provider:
    _graph_name = "g1"
    _conn_cfg = None

    def __init__(self) -> None:
        self.calls = 0
        self.raise_exc: BaseException | None = None

    @property
    def name(self) -> str:
        return "p"

    async def get_nodes(self) -> list:
        self.calls += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        return []

    async def close(self) -> None:  # pragma: no cover
        pass


class _FakeRedis:
    def __init__(self) -> None:
        self.kv: dict = {}
        self.ttls: dict = {}
        self.gets = 0

    async def set(self, key, value, ex=None, **_kw):
        self.kv[key] = value
        self.ttls[key] = ex
        return True

    async def get(self, key):
        self.gets += 1
        return self.kv.get(key)


class _DownRedis:
    def __getattr__(self, name):
        async def _fail(*a, **k):
            raise ConnectionError("redis down")
        return _fail


@pytest.fixture
def listeners():
    saved = list(circuit._CAPACITY_LISTENERS)
    circuit._CAPACITY_LISTENERS.clear()
    yield circuit._CAPACITY_LISTENERS
    circuit._CAPACITY_LISTENERS[:] = saved


async def _settle(signal: rp.ReadPressureSignal) -> None:
    if signal._tasks:
        await asyncio.gather(*list(signal._tasks), return_exceptions=True)


# ── 1. The breaker publishes capacity signals ──────────────────────────


async def test_breaker_publishes_the_three_capacity_signals(listeners) -> None:
    from redis.exceptions import ResponseError

    seen: list[tuple[str, object]] = []
    circuit.register_capacity_listener(lambda kind, target: seen.append((kind, target)))
    circuit.register_capacity_listener(listeners[0])   # idempotent
    assert len(listeners) == 1

    target = _Provider()
    proxy = CircuitBreakerProxy(target, name="t", fail_max=3)

    target.raise_exc = ResponseError("Max pending queries exceeded")
    with pytest.raises(ProviderBusy):
        await proxy.get_nodes()
    target.raise_exc = ResponseError("Query timed out")
    with pytest.raises(ProviderTimeout):
        await proxy.get_nodes()
    target.raise_exc = asyncio.TimeoutError("nodes.query exceeded 20s")
    with pytest.raises(ProviderTimeout):
        await proxy.get_nodes()

    assert [kind for kind, _ in seen] == ["queue_full", "server_timeout", "deadline"]
    assert all(t is target for _, t in seen), "listeners get the wrapped provider"


async def test_rejected_queries_and_network_errors_publish_nothing(listeners) -> None:
    from redis.exceptions import ResponseError

    seen: list = []
    circuit.register_capacity_listener(lambda kind, target: seen.append(kind))
    target = _Provider()
    proxy = CircuitBreakerProxy(target, name="t", fail_max=3)

    target.raise_exc = ResponseError("Invalid input 'X': expected ...")
    with pytest.raises(ResponseError):
        await proxy.get_nodes()
    target.raise_exc = ConnectionError("refused")
    with pytest.raises(ProviderUnavailable):
        await proxy.get_nodes()
    assert seen == []


async def test_a_failing_listener_never_reaches_the_request(listeners) -> None:
    from redis.exceptions import ResponseError

    def _boom(kind, target):
        raise RuntimeError("listener bug")

    circuit.register_capacity_listener(_boom)
    target = _Provider()
    target.raise_exc = ResponseError("Max pending queries exceeded")
    proxy = CircuitBreakerProxy(target, name="t", fail_max=3)

    with pytest.raises(ProviderBusy):   # still the busy signal, not RuntimeError
        await proxy.get_nodes()
    assert proxy.breaker_state == "closed"


# ── 2. The web tier stamps the shared key ─────────────────────────────


async def test_signal_stamps_the_endpoint_key_with_a_ttl_and_coalesces() -> None:
    redis = _FakeRedis()
    signal = rp.ReadPressureSignal(lambda: redis)
    provider = _Provider()
    key = adm.read_pressure_key(adm.endpoint_key(provider))
    before = rp.read_pressure_stats()

    signal.on_capacity("queue_full", provider)
    signal.on_capacity("deadline", provider)      # inside the coalesce window
    await _settle(signal)

    assert redis.kv[key] == "queue_full"
    assert redis.ttls[key] == rp._TTL_S
    after = rp.read_pressure_stats()
    assert after["signals_sent"] == before["signals_sent"] + 1
    assert after["signals_coalesced"] == before["signals_coalesced"] + 1


async def test_signal_fails_open_when_redis_is_down() -> None:
    signal = rp.ReadPressureSignal(_DownRedis)
    before = rp.read_pressure_stats()["signal_errors"]

    signal.on_capacity("server_timeout", _Provider())   # must not raise
    await _settle(signal)

    assert rp.read_pressure_stats()["signal_errors"] == before + 1


# ── 3. The worker reads it, memoised, fail-open ────────────────────────


async def test_admission_reads_pressure_and_memoises(monkeypatch) -> None:
    redis = _FakeRedis()
    a = adm.AggregationAdmission(redis)
    provider = _Provider()
    key = adm.read_pressure_key(adm.endpoint_key(provider))

    assert await a.read_pressure(provider) is None
    redis.kv[key] = "queue_full"
    assert await a.read_pressure(provider) is None, "verdict is reused inside the poll window"
    assert redis.gets == 1

    monkeypatch.setattr(adm, "_READ_PRESSURE_POLL_SECS", 0.0)
    assert await a.read_pressure(provider) == "queue_full"
    del redis.kv[key]
    assert await a.read_pressure(provider) is None


async def test_admission_read_pressure_fails_open() -> None:
    a = adm.AggregationAdmission(_DownRedis())
    assert await a.read_pressure(_Provider()) is None


# ── 4. The pacing loop yields ─────────────────────────────────────────


class _Admission:
    def __init__(self, pressure: str | None = None) -> None:
        self.pressure = pressure

    def write_slot(self, provider):
        class _Slot:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        return _Slot()

    async def read_pressure(self, provider):
        return self.pressure


class _Clock:
    """time.monotonic() that advances 0.5s per call → every write "takes" 0.5s."""

    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        self.now += 0.5
        return self.now


def _pipeline(admission) -> mat.AggregationPipeline:
    p = mat.AggregationPipeline.__new__(mat.AggregationPipeline)
    provider = _Provider()
    provider._admission_controller = admission
    p.p = provider
    p._pacing_ratio = 1.0
    p._read_pressure_pacing_ratio = 4.0
    p._yielding_to_reads = False
    p._read_pressure_yields = 0
    # `_paced_write` also gates on replica acknowledgement. These tests are
    # about the READ-pressure yield, so the replica gate is off: no live
    # override, and a fleet minimum of 0 replicas, which returns before the
    # gate touches anything else. Building the object with `__new__` means
    # every attribute the write path reaches has to be named here — when a
    # new one appears, this is where it goes.
    p._live = {}
    p._replica_ack_min = 0
    # `_paced_write` also runs the write governor first. It reads the node
    # through the provider's client — none here — so the reading is
    # unmeasured and the governor never holds; these are the attributes the
    # governor's reading and record touch on that path.
    p._hold_max_s = 1800
    p._expected_replicas = None
    p._node_config = None
    p._container_env_bytes = None
    p._gov_reading = None
    p._gov_read_at = 0.0
    p._store_holds = {}
    p._store_hold_s = {}
    p._store_hold_last = None
    # …and the steady-load scheduler: the ceiling, the target, the minimum
    # gap (below every sleep these tests assert), the meter and the easing.
    p._write_batch_max = 500
    p._write_batch_target_s = 1.0
    p._write_min_gap_ms = 100
    p._pace = mat._PaceMeter()
    p._eased = None
    p._eases = {}
    return p


async def test_paced_write_stretches_the_sleep_while_reads_starve(monkeypatch) -> None:
    sleeps: list[float] = []

    async def _sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    monkeypatch.setattr(mat, "time", _Clock())
    admission = _Admission()
    pipeline = _pipeline(admission)

    async def _write():
        return "ok"

    elapsed, result = await pipeline._paced_write(_write)
    assert (elapsed, result) == (0.5, "ok")
    assert sleeps == [0.5]                       # base ratio 1.0

    admission.pressure = "queue_full"
    await pipeline._paced_write(_write)
    assert sleeps[-1] == 2.0                     # read-pressure ratio 4.0
    assert pipeline._yielding_to_reads is True
    assert pipeline._read_pressure_yields == 1

    admission.pressure = None
    await pipeline._paced_write(_write)
    assert sleeps[-1] == 0.5
    assert pipeline._yielding_to_reads is False
    assert pipeline._read_pressure_yields == 1


async def test_paced_write_never_gets_faster_under_pressure(monkeypatch) -> None:
    """The larger ratio wins: an operator who already paces harder than the
    read-pressure default is not sped up by a signal."""
    sleeps: list[float] = []

    async def _sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    monkeypatch.setattr(mat, "time", _Clock())
    pipeline = _pipeline(_Admission(pressure="deadline"))
    pipeline._pacing_ratio = 6.0

    async def _write():
        return None

    await pipeline._paced_write(_write)
    assert sleeps == [3.0]


async def test_paced_write_is_unchanged_without_the_check(monkeypatch) -> None:
    sleeps: list[float] = []

    async def _sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    monkeypatch.setattr(mat, "time", _Clock())

    class _LegacyAdmission(_Admission):
        read_pressure = None   # an admission controller without the check

    pipeline = _pipeline(_LegacyAdmission())

    async def _write():
        return None

    await pipeline._paced_write(_write)
    assert sleeps == [0.5]
    assert pipeline._yielding_to_reads is False
