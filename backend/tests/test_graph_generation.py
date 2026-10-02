"""A dropped-and-recreated FalkorDB graph must never be decoded with the old id tables.

falkordb-py decodes labels, relationship types and property keys through a per-Graph copy
of the graph's catalogue, refreshed only when an id is out of range (the async client never
sends a schema version, and its version-mismatch refresh is never awaited). A graph that is
dropped and written again gets a new catalogue under the same name, so every long-lived
handle decodes with the wrong names — the incident where every Domain rendered as
"Schema Field".

Rebuilds no longer drop (they reconcile in place). The drops that remain — eviction and
purge — bump a per-graph generation, and every provider checks it (throttled) before a
query and clears its handles' tables when it moved.
"""
import asyncio
from types import SimpleNamespace

from backend.app.providers.graph_generation import GraphRebuildWatch
from backend.app.providers.falkordb_provider import FalkorDBProvider


class _Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def _watch(values, clock):
    reads = []

    async def reader(name):
        reads.append(name)
        return values[name]
    return GraphRebuildWatch(reader=reader, clock=clock, interval_s=2.0), reads


def test_first_look_only_records_the_generation():
    clock = _Clock()
    w, _ = _watch({"g": "3"}, clock)
    assert asyncio.run(w.rebuilt("g")) is False


def test_a_bumped_generation_is_reported_once():
    clock, values = _Clock(), {"g": None}
    w, _ = _watch(values, clock)
    assert asyncio.run(w.rebuilt("g")) is False
    values["g"] = "1"                                    # the graph was dropped
    clock.t += 3
    assert asyncio.run(w.rebuilt("g")) is True
    clock.t += 3
    assert asyncio.run(w.rebuilt("g")) is False


def test_checks_are_throttled():
    clock, values = _Clock(), {"g": "1"}
    w, reads = _watch(values, clock)
    asyncio.run(w.rebuilt("g"))
    values["g"] = "2"
    clock.t += 0.5
    assert asyncio.run(w.rebuilt("g")) is False          # inside the interval: no read at all
    assert reads == ["g"]
    clock.t += 2
    assert asyncio.run(w.rebuilt("g")) is True


def test_an_unreadable_generation_changes_nothing():
    clock = _Clock()

    async def broken(_name):
        raise ConnectionError("bus down")
    w = GraphRebuildWatch(reader=broken, clock=clock, interval_s=2.0)
    assert asyncio.run(w.rebuilt("g")) is False


def test_the_provider_clears_its_handles_tables_and_graph_caches():
    p = FalkorDBProvider(host="h", port=6379, graph_name="g", auto_reconcile=False)
    schema = SimpleNamespace(cleared=0)
    schema.clear = lambda: setattr(schema, "cleared", schema.cleared + 1)
    p._graph = SimpleNamespace(schema=schema)
    p._agg_meta_cached = ("meta", 1.0)
    p._save_indices_ensured = True

    class _Rebuilt:
        async def rebuilt(self, _name):
            return True
    p._rebuild_watch = _Rebuilt()
    asyncio.run(p._refresh_if_graph_rebuilt())
    assert schema.cleared == 1
    assert p._agg_meta_cached is None and p._save_indices_ensured is False


def test_a_structural_change_clears_the_shared_label_and_ancestor_caches():
    # A stale urn→label anchors a lookup on the OLD label and finds nothing: after a
    # retype the entity would read as missing. Ancestor chains go stale on a move.
    p = FalkorDBProvider(host="h", port=6379, graph_name="g", auto_reconcile=False)
    deleted = []

    class _Redis:
        async def scan(self, cursor, match=None, count=None):
            return 0, [f"{match[:-1]}d1", f"{match[:-1]}d2"]

        async def unlink(self, *keys):                   # non-blocking, unlike DEL
            deleted.extend(keys)

    class _Rebuilt:
        async def rebuilt(self, _name):
            return True
    p._redis = _Redis()
    p._rebuild_watch = _Rebuilt()
    p._label_warmup_until = 10 ** 9

    async def run():
        await p._refresh_if_graph_rebuilt()
        await asyncio.sleep(0.01)                        # the drop runs in the background
    asyncio.run(run())
    assert p._label_warmup_until == 0.0, "the label cache must refill now, not after the cooldown"
    assert p._urn_label_key() in deleted
    assert any(":ancestors:" in k for k in deleted)


def test_a_window_that_retypes_or_reparents_is_structural():
    from backend.app.services.versioning.projection import FalkorProjector

    class _Svc:
        async def _values_at(self, s, gid, branch, ids, seq):
            return {"n1": {"entityType": "domain"}, "b": {"entityType": "dataset"}}

    async def _types(_svc, _gid):
        return (["CONTAINS"], ["TRANSFORMS"])

    proj = FalkorProjector(graph_client_factory=lambda *a, **k: None, edge_types_resolver=_types)
    proj._svc = _Svc()
    g = SimpleNamespace(id="g")
    lineage = ("e", "a", "b", {"edgeType": "TRANSFORMS"}, "t", "t")
    contain = ("e", "a", "b", {"edgeType": "CONTAINS", "sourceEntityId": "a",
                                "targetEntityId": "b"}, "t", "t")          # b existed: a move
    new_child = ("e2", "a", "c", {"edgeType": "CONTAINS", "sourceEntityId": "a",
                                  "targetEntityId": "c"}, "t", "t")        # c is new
    run = lambda ch: asyncio.run(proj._window_is_structural(None, g, "m", 3, ch))
    assert run(([], [lineage], [], [])) is False                     # lineage only
    assert run(([], [contain], [], [])) is True                      # re-parent
    assert run(([], [new_child], [], [])) is False                   # creating inside a container
    assert run(([], [], [], [{"rel": "CONTAINS"}])) is True          # a link removed
    assert run(([("n1", "u1", {"entityType": "schemaField"})], [], [], [])) is True  # retype
    assert run(([("n1", "u1", {"entityType": "domain", "displayName": "x"})], [], [], [])) is False
    assert run(([], [], [], [])) is False


def test_a_slow_bus_costs_a_query_at_most_the_read_timeout():
    clock = _Clock()

    async def slow(_name):
        await asyncio.sleep(5)

    w = GraphRebuildWatch(reader=slow, clock=clock, interval_s=2.0, read_timeout_s=0.05)
    import time as _t
    t0 = _t.monotonic()
    assert asyncio.run(w.rebuilt("g")) is False
    assert _t.monotonic() - t0 < 1.0
