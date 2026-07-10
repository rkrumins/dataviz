"""on_lineage_edge_deleted contract (F3 audit finding, data-loss class).

The old hook (a) built the FULL ancestor cross-product instead of the
canonical level-bridged selection the write hook and batch pipeline
share, (b) OVERWROTE ``r.weight`` from a Redis SCARD — a separate
accounting system the batch pipeline never populates, so a single raw
deletion clobbered a pipeline-computed weight (the same class as the
observed "12,000 → 1") — and (c) DELETED any pair whose members set was
empty, i.e. every batch-written cell. It also matched nodes unlabeled
under UNWIND.

The contract now: canonical pairs only; SREM is the gate (only a pair
this edge verifiably contributed to is touched); the graph write is a
decrement-by-one via the AGGREGATED(aggKey) edge-index seek — never a
weight overwrite, never a members-empty delete, never an unlabeled node
match. Untracked pairs are left for the batch pipeline's reconcile.
"""
import asyncio

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.run(coro)


class _Pipe:
    def __init__(self, redis):
        self._redis = redis
        self._ops = []

    def execute_command(self, cmd, key, *args):
        self._ops.append((cmd, key, args))

    def srem(self, key, *args):
        self._ops.append(("SREM", key, args))

    def hget(self, key, field):
        self._ops.append(("HGET", key, (field,)))

    async def execute(self):
        out = []
        for cmd, key, args in self._ops:
            if cmd == "SREM":
                members = self._redis.sets.get(key, set())
                removed = args[0] in members
                members.discard(args[0])
                out.append(1 if removed else 0)
            elif cmd == "HGET":
                out.append(self._redis.hashes.get(key, {}).get(args[0]))
            elif cmd == "SADD":
                members = self._redis.sets.setdefault(key, set())
                new = args[0] not in members
                members.add(args[0])
                out.append(1 if new else 0)
            elif cmd == "SCARD":
                out.append(len(self._redis.sets.get(key, set())))
        self._ops = []
        return out


class _Redis:
    def __init__(self):
        self.sets = {}
        self.hashes = {}

    def pipeline(self, transaction=False):
        return _Pipe(self)


def _provider(levels, redis, calls):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = levels

    async def noop():
        return None

    async def ancestors(urn):
        chain, idx = urn[4], int(urn[5])
        return [f"urn:{chain}{i}" for i in range(idx - 1, -1, -1)]

    async def proj_query(cypher, params=None, timeout=None):
        calls.append((cypher, params, timeout))

    p._ensure_connected = noop
    p._get_ancestor_chain = ancestors
    p._redis = redis
    p._urn_label_key = lambda: "labels"
    p._proj_query = proj_query
    return p


def _levels(depth=4):
    return {f"lvl{i}": i for i in range(depth)}


def _label_hash(depth=4):
    return {f"urn:{c}{i}": f"lvl{i}" for c in ("a", "b") for i in range(depth)}


def _track(redis, s, t, edge_id="edge-1"):
    redis.sets[f"g:agg_members:{s}:{t}"] = {edge_id}


def test_tracked_canonical_pairs_decrement_via_aggkey_seek():
    redis = _Redis()
    redis.hashes["labels"] = _label_hash()
    for i in range(3):                       # the canonical diagonal
        _track(redis, f"urn:a{i}", f"urn:b{i}")
    calls = []
    p = _provider(_levels(), redis, calls)

    _run(p.on_lineage_edge_deleted("urn:a3", "urn:b3", "edge-1"))

    assert calls, "tracked canonical pairs must produce a graph write"
    keys = set()
    for cypher, params, _t in calls:
        assert "AGGREGATED {aggKey:" in cypher, cypher
        assert "r.weight - 1" in cypher, cypher
        assert "r.weight <= 0" in cypher and "DELETE r" in cypher, cypher
        assert "SET r.weight = item.w" not in cypher, (
            "weight must never be overwritten from Redis set cardinality"
        )
        assert "MATCH (s {urn:" not in cypher and "MATCH (t {urn:" not in cypher
        keys.update(params["keys"])
    assert keys == {
        "urn:a2|urn:b2", "urn:a1|urn:b1", "urn:a0|urn:b0",
    }, "canonical diagonal only — no leaf-involving or mixed-level pairs"


def test_untracked_pairs_never_touch_the_graph():
    redis = _Redis()                          # no members sets at all —
    redis.hashes["labels"] = _label_hash()    # the batch pipeline's regime
    calls = []
    p = _provider(_levels(), redis, calls)

    _run(p.on_lineage_edge_deleted("urn:a3", "urn:b3", "edge-1"))

    assert calls == [], (
        "SREM removed nothing ⇒ this edge never contributed via the hook; "
        "touching the batch pipeline's weights would repeat the "
        "SCARD-clobber data-loss bug"
    )


def test_unresolved_levels_defer_to_the_batch_pipeline():
    redis = _Redis()                          # label cache cold: no hashes
    _track(redis, "urn:a2", "urn:b2")
    calls = []
    p = _provider(_levels(), redis, calls)

    _run(p.on_lineage_edge_deleted("urn:a3", "urn:b3", "edge-1"))

    assert calls == [], (
        "a partially-resolved chain yields non-canonical pairs — defer, "
        "exactly like on_lineage_edge_written does"
    )


def test_levelless_graphs_use_structural_canonical_pairs():
    """Level maps are STAMPS, never the selector: a level-less graph
    still decrements the structural (depth-ranked ancestor) canonical
    pairs — mirror of the write hook and the batch pipeline."""
    redis = _Redis()
    _track(redis, "urn:a0", "urn:b0")         # the structural root pair
    _track(redis, "urn:a1", "urn:b0")         # legacy cross-product cell — untracked by selection
    calls = []
    p = _provider(None, redis, calls)         # no level map at all

    _run(p.on_lineage_edge_deleted("urn:a1", "urn:b1", "edge-1"))

    keys = set()
    for _c, params, _t in calls:
        keys.update(params["keys"])
    assert keys == {"urn:a0|urn:b0"}, (
        "structural canonical candidates only — the old full "
        "cross-product wrote cells the batch pipeline never owns"
    )
