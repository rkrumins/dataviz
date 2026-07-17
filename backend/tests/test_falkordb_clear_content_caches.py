"""Tests for `FalkorDBProvider.clear_content_caches` — the bulk
counterpart to the per-node `on_containment_changed`.

Background: the provider keeps long-lived Redis content caches
(ancestor-chain hashes per containment-digest namespace, TTL 7 days;
the urn→label hash) keyed by containment TYPE SET, not graph content.
After an external bulk load/re-parent, both the read path and the
aggregation rebuild worker would keep consuming stale chains with no
way to clear the whole graph's cached state at once. This method is
called only from the confirmed-source-change signal path (a later
task) — its behavior must be best-effort and never-raising.
"""
import asyncio
import fnmatch

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.run(coro)


async def _noop_connect():
    return None


class _FakeCacheRedis:
    """Minimal SCAN/DELETE-capable fake over an in-memory key set."""

    def __init__(self, keys):
        self.store = set(keys)

    async def scan(self, cursor, match=None, count=None):
        matched = [k for k in self.store if fnmatch.fnmatch(k, match)] if match else list(self.store)
        return 0, matched

    async def delete(self, *keys):
        for k in keys:
            self.store.discard(k)


class _BoomRedis:
    async def scan(self, cursor, match=None, count=None):
        raise ConnectionError("redis unreachable")

    async def delete(self, *keys):
        raise ConnectionError("redis unreachable")


def test_clears_ancestor_and_label_keys_but_spares_unrelated_key():
    p = FalkorDBProvider(host="x", graph_name="g")
    ns = p._cache_ns
    keys = {
        f"{ns}:ancestors:abc123",
        f"{ns}:ancestors:def456",
        p._urn_label_key(),
        f"{ns}:agg:regime",  # unrelated marker — must survive
    }
    redis = _FakeCacheRedis(keys)
    p._redis = redis
    p._ensure_connected = _noop_connect
    p._agg_meta_cached = ("stale-meta-sentinel", 123.0)

    _run(p.clear_content_caches())

    assert redis.store == {f"{ns}:agg:regime"}
    assert p._agg_meta_cached is None


def test_resets_run_meta_memo_even_when_no_redis_configured():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    p._ensure_connected = _noop_connect
    p._agg_meta_cached = ("stale-meta-sentinel", 123.0)

    _run(p.clear_content_caches())  # silent no-op on the Redis side

    assert p._agg_meta_cached is None


def test_redis_failure_is_logged_and_swallowed():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = _BoomRedis()
    p._ensure_connected = _noop_connect
    p._agg_meta_cached = ("stale-meta-sentinel", 123.0)

    _run(p.clear_content_caches())  # must not raise

    assert p._agg_meta_cached is None
