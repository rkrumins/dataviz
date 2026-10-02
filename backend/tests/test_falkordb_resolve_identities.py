"""``resolve_identities`` on FalkorDB: which URNs exist here, and as what.

A view from another environment can name tens of thousands of entities that aren't in this
graph, and each is sought under every label before it may be called missing. Pinned here:

* found under the label the urn→label cache holds; a stale cache entry is not proof of absence,
  so the URN is sought under every other label and found there;
* missing only when every label's seek succeeded without it; a URN whose seek failed and that
  no other label held stays unknown, never "missing";
* no URN is sought under the same label twice (the label bootstrap of ``_label_buckets`` used to
  search every label, then the confirmation pass searched them all again);
* seeks run a few at a time, never more than ``_RESOLVE_IDENTITIES_CONCURRENCY``.
"""
import asyncio
from collections import Counter

from backend.app.providers.falkordb_provider import FalkorDBProvider


class _Res:
    def __init__(self, rows):
        self.result_set = rows


class _Pipeline:
    def __init__(self, cache):
        self._cache, self._keys = cache, []

    def hget(self, _key, field):
        self._keys.append(field)

    async def execute(self):
        return [self._cache.get(k) for k in self._keys]


class _Redis:
    def __init__(self, cache):
        self._cache = cache

    def pipeline(self, transaction=False):
        return _Pipeline(self._cache)


def _provider(graph, *, cache=None, failing=()):
    """``graph`` maps label → {urn: name}; ``failing`` names labels whose seeks raise."""
    p = FalkorDBProvider(host="x", graph_name="g")

    async def _noop():
        return None

    p._ensure_connected = _noop
    p._redis = _Redis(cache) if cache is not None else None
    sought = Counter()
    in_flight = {"now": 0, "most": 0}

    async def _ro_query(cypher, params=None, **kw):
        if "db.labels()" in cypher:
            return _Res([[label] for label in graph])
        # The label bootstrap's seek (``_resolve_urn_labels_bulk``): counted like any other.
        label = cypher.split("MATCH (n:", 1)[1].split(")", 1)[0]
        for urn in params["urns"]:
            sought[(label, urn)] += 1
        return _Res([[u] for u in params["urns"] if u in graph.get(label, {})])

    async def _identity_seek(label, urns):
        in_flight["now"] += 1
        in_flight["most"] = max(in_flight["most"], in_flight["now"])
        try:
            await asyncio.sleep(0)
            for urn in urns:
                sought[(label, urn)] += 1
            if label in failing:
                raise RuntimeError("seek failed")
            held = graph.get(label, {})
            return {u: {"urn": u, "type": label, "name": held[u]} for u in urns if u in held}
        finally:
            in_flight["now"] -= 1

    p._ro_query = _ro_query
    p._identity_seek = _identity_seek
    return p, sought, in_flight


async def test_found_under_the_cached_label_or_anywhere_else():
    graph = {"Table": {"urn:a": "orders"}, "View": {"urn:b": "revenue"}}
    # urn:b's cached label is stale: it was re-typed from Table to View.
    p, _, _ = _provider(graph, cache={"urn:a": b"Table", "urn:b": b"Table"})
    out = await p.resolve_identities(["urn:a", "urn:b", "urn:gone"])
    assert out["urn:a"]["name"] == "orders"
    assert out["urn:b"]["type"] == "View", "a stale cache entry is not proof of absence"
    assert out["urn:gone"] is None


async def test_a_failed_seek_leaves_a_urn_unknown_never_missing():
    graph = {"Table": {"urn:a": "orders"}, "View": {}}
    p, _, _ = _provider(graph, failing={"View"})
    out = await p.resolve_identities(["urn:a", "urn:gone"])
    assert out["urn:a"]["name"] == "orders", "found under a label whose seek worked"
    assert "urn:gone" not in out, "not every label could be asked, so it is unknown"


async def test_no_urn_is_sought_under_the_same_label_twice():
    graph = {f"Type{i}": {} for i in range(10)}
    urns = [f"urn:gone:{j}" for j in range(50)]
    p, sought, _ = _provider(graph, cache={})
    out = await p.resolve_identities(urns)
    assert all(out[u] is None for u in urns)
    assert set(sought.values()) == {1}
    assert len(sought) == len(urns) * len(graph)


async def test_seeks_run_a_few_at_a_time():
    graph = {f"Type{i}": {} for i in range(12)}
    p, _, in_flight = _provider(graph)
    p._RESOLVE_IDENTITIES_CHUNK = 5
    await p.resolve_identities([f"urn:gone:{j}" for j in range(40)])
    assert 1 < in_flight["most"] <= p._RESOLVE_IDENTITIES_CONCURRENCY
