"""Purge must be VISIBLE to every aggregation-state consumer.

Live incident (2026-07-11): a purge deleted every :AGGREGATED cell but
bumped no state marker, so canvases kept serving pre-purge answers from
cache (the response's lastMaterializedAt — the client invalidation
epoch — never changed), and the skip-reaggregate opt-out was moot
because the read path's empty-result backfill rebuilt the cells on the
next canvas load anyway.
"""
import asyncio
from types import SimpleNamespace

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.insights_service.purge import _arm_purge_quarantine


def _run(coro):
    return asyncio.run(coro)


class _Redis:
    def __init__(self):
        self.store = {}
        self.deleted = []

    async def scan(self, cursor, match=None, count=None):
        return 0, []

    async def delete(self, *keys):
        self.deleted.extend(keys)
        for k in keys:
            self.store.pop(k, None)

    async def set(self, key, value, ex=None):
        self.store[key] = (value, ex)


def test_purge_bumps_epoch_and_drops_regime():
    p = FalkorDBProvider(host="x", graph_name="g")
    redis = _Redis()
    p._redis = redis

    async def noop():
        return None

    calls = {"n": 0}

    async def proj_query(cypher, params=None, **kw):
        calls["n"] += 1
        # First batch deletes everything; second returns 0 → loop ends.
        n = 3 if calls["n"] == 1 else 0
        return SimpleNamespace(result_set=[[n]])

    p._ensure_connected = noop
    p._proj_query = proj_query

    deleted = _run(p.purge_aggregated_edges(batch_size=10_000))

    assert deleted == 3
    epoch_key = p._agg_last_materialized_key()
    assert epoch_key in redis.store, (
        "purge must bump lastMaterializedAt — it is the client caches' "
        "invalidation epoch"
    )
    # The regime marker is overwritten to 'fine' (cube contract), not
    # deleted: with the marker (and _AggMeta) gone, readers RE-PROBE the
    # empty store, resolve 'boundary', and the structural on-demand
    # reader re-derives the purged cells from raw lineage on the next
    # canvas read — purge-then-resurrect. 'fine' keeps derivation off
    # while still not advertising the pre-purge shape.
    regime_val = redis.store.get(p._agg_regime_key())
    if isinstance(regime_val, tuple):
        regime_val = regime_val[0]
    assert regime_val == "fine", (
        "an empty store must keep on-demand derivation OFF (cube "
        "contract), or readers resurrect the purged cells from raw"
    )


def test_skip_reaggregate_purge_arms_the_backfill_quarantine():
    redis = _Redis()
    provider = SimpleNamespace(_redis=redis)
    job = SimpleNamespace(
        data_source_id="ds-1",
        tuning_json='{"skip_reaggregate": true}',
    )
    _run(_arm_purge_quarantine(provider, job))
    value, ttl = redis.store["materialize:in-flight:ds-1"]
    assert value == "purge-quarantine" and ttl == 900


def test_default_purge_does_not_quarantine():
    redis = _Redis()
    provider = SimpleNamespace(_redis=redis)
    job = SimpleNamespace(data_source_id="ds-1", tuning_json=None)
    _run(_arm_purge_quarantine(provider, job))
    assert redis.store == {}
