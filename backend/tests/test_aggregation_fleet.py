"""Unit tests for the worker fleet registry + memory-aware claim policy."""
import asyncio
import json
import time

from backend.app.services.aggregation import fleet as fl


class _FakeRedis:
    def __init__(self):
        self.kv = {}
        self.stream_len = 7

    async def set(self, key, value, ex=None):
        self.kv[key] = value
        return True

    async def get(self, key):
        return self.kv.get(key)

    async def delete(self, key):
        self.kv.pop(key, None)
        return 1

    async def scan(self, cursor=0, match=None, count=100):
        keys = [k for k in self.kv if k.startswith(fl.WORKER_KEY_PREFIX)]
        return 0, keys

    async def xlen(self, stream):
        return self.stream_len

    async def xpending(self, stream, group):
        return {"pending": 3}


def _run(coro):
    return asyncio.run(coro)


def test_claim_decision_drain_and_large_cap(monkeypatch):
    member = fl.WorkerFleetMember(_FakeRedis(), "w1", concurrency=4)
    monkeypatch.setattr(fl, "read_rss_mb", lambda: None)
    monkeypatch.setattr(fl, "read_mem_limit_mb", lambda: None)

    # Small job, healthy worker → claim allowed.
    assert member.claim_decision(total_edges=100) is None
    # Large-job cap: one large job active blocks the second large job but
    # NOT small ones.
    member.register_job("j1", graph_name="g", large=True)
    assert member.claim_decision(total_edges=fl.LARGE_JOB_EDGE_THRESHOLD) is not None
    assert member.claim_decision(total_edges=10) is None
    member.unregister_job("j1")
    assert member.claim_decision(total_edges=fl.LARGE_JOB_EDGE_THRESHOLD) is None
    # Drain blocks everything.
    member.drain = True
    assert member.claim_decision(total_edges=1) is not None


def test_claim_decision_memory_high_water(monkeypatch):
    member = fl.WorkerFleetMember(_FakeRedis(), "w1", concurrency=4)
    monkeypatch.setattr(fl, "read_mem_limit_mb", lambda: 1000.0)
    monkeypatch.setattr(fl, "read_rss_mb", lambda: 900.0)  # 90% > 75%
    reason = member.claim_decision(total_edges=10)
    assert reason is not None and "high-water" in reason

    monkeypatch.setattr(fl, "read_rss_mb", lambda: 100.0)  # 10%
    assert member.claim_decision(total_edges=10) is None


def test_heartbeat_registry_shape(monkeypatch):
    redis = _FakeRedis()
    member = fl.WorkerFleetMember(redis, "w-test", concurrency=3)
    member.register_job("j9", graph_name="graph9", large=True)
    member.set_job_phase("j9", "applying")
    monkeypatch.setattr(fl, "read_rss_mb", lambda: 512.0)
    monkeypatch.setattr(fl, "read_mem_limit_mb", lambda: 4096.0)

    _run(member.heartbeat())

    raw = redis.kv[f"{fl.WORKER_KEY_PREFIX}w-test"]
    data = json.loads(raw)
    assert data["worker_id"] == "w-test"
    assert data["concurrency"] == 3
    assert data["large_jobs_active"] == 1
    assert data["rss_mb"] == 512.0
    assert data["active_jobs"][0]["jobId"] == "j9"
    assert data["active_jobs"][0]["phase"] == "applying"
    assert data["drain"] is False


def test_heartbeat_fails_open(monkeypatch):
    class _Down:
        async def set(self, *a, **k):
            raise ConnectionError("down")

    member = fl.WorkerFleetMember(_Down(), "w1", concurrency=1)
    _run(member.heartbeat())  # must not raise


def test_read_fleet_aggregates_workers_and_queue(monkeypatch):
    redis = _FakeRedis()
    member = fl.WorkerFleetMember(redis, "w-a", concurrency=2)
    member.register_job("j1", graph_name="g1", large=False)
    monkeypatch.setattr(fl, "read_rss_mb", lambda: 256.0)
    monkeypatch.setattr(fl, "read_mem_limit_mb", lambda: 2048.0)
    _run(member.heartbeat())

    import backend.app.services.aggregation.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", lambda: redis)

    resp = _run(fl.read_fleet())
    assert resp.queue_depth == 7
    assert resp.queue_pending == 3
    assert len(resp.workers) == 1
    w = resp.workers[0]
    assert w.worker_id == "w-a"
    assert w.active_jobs[0].job_id == "j1"
    assert w.rss_mb == 256.0


def test_mem_readers_do_not_crash():
    # On Linux these read real /proc + cgroup files; elsewhere they return
    # None. Either way they must never raise.
    rss = fl.read_rss_mb()
    limit = fl.read_mem_limit_mb()
    assert rss is None or rss > 0
    assert limit is None or limit > 0
