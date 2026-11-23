"""The projector's statement ladder (``FalkorProjector._laddered``): every chunked statement fits
its FalkorDB budget, whatever size the graph's statements can take.

Pins:
- A statement that times out over N rows is sent in halves until it fits, and every row lands.
- The width that worked is kept for that graph and statement kind, so the next call starts there.
- It grows back by a quarter after eight quick chunks, never past the batch size; a chunk that used
  more than half its budget halves it (AIMD).
- A memory refusal is handled like a timeout. A connection failure, or any other error, is raised
  at once, unretried, so the pass backs off.
- One row that still fails is retried ``PROJECTION_FLOOR_RETRIES`` times, waiting longer each time,
  then handed to ``at_floor``. Unhandled, it fails the pass.
- ``on_result`` sees every chunk that landed, halves included; ``progress`` counts them.
- A rebuild deletes every copy of a node the key holds twice, in place or a page at a time, and a
  copy that is a hub has its relationships deleted a page at a time first, then the copies.
- Reads come first: a write is cut off at New-version builds' ``writeCeilingSecs`` on every
  FalkorDB mode; a chunk slower than ``statementTargetMs`` narrows the next, never below fifty rows
  for being slow; each write is followed by a pause of ``pacingRatio`` times what it took,
  ``readPressureRatio`` times while reads on its node starve, at most five seconds.
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import config, projection
from backend.app.services.versioning.projection import FalkorProjector, _PassStats, _PASS_STATS
from backend.app.services.versioning.projection_reconcile import ActualNode, ExpectedNode


class _Graph:
    """A FalkorDB client that times out on more than ``limit`` rows, and on any row in ``poison``."""

    def __init__(self, name="g", limit=None, poison=(), error="Query timed out"):
        self.name, self.limit, self.poison, self.error = name, limit, set(poison), error
        self.sizes: list = []
        self.landed: list = []

    async def query(self, cypher, params=None, timeout=None):
        rows = (params or {}).get("batch") or (params or {}).get("urns") or []
        self.sizes.append(len(rows))
        if (self.limit is not None and len(rows) > self.limit) or self.poison & set(map(str, rows)):
            raise Exception(self.error)
        self.landed.extend(rows)

        class _Res:
            result_set = [[len(rows)]]
        return _Res()


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    projection._WIDTHS.clear()
    waits: list = []

    async def no_wait(seconds):
        waits.append(seconds)

    monkeypatch.setattr(projection, "_sleep", no_wait)
    monkeypatch.setattr(projection, "_floor_backoff_s", lambda attempt: 2.0 ** (attempt + 1))
    yield waits
    projection._WIDTHS.clear()


def _projector(batch=5000) -> FalkorProjector:
    return FalkorProjector(graph_client_factory=lambda *_a: None, batch_size=batch)


async def test_a_statement_too_large_is_sent_in_halves_until_every_row_lands():
    g, p = _Graph(limit=700), _projector()
    stats = _PassStats()
    token = _PASS_STATS.set(stats)
    try:
        await p._laddered(g, "node_merge", "UNWIND $batch AS item RETURN 1", list(range(5000)))
    finally:
        _PASS_STATS.reset(token)
    assert sorted(g.landed) == list(range(5000))
    width = projection._WIDTHS[("g", "node_merge")].value
    assert 1 <= width <= 700, width
    assert stats.shrinks >= 3 and stats.min_width <= 700 and stats.rows == 5000


async def test_the_width_that_worked_is_where_the_next_call_starts():
    g, p = _Graph(limit=700), _projector()
    await p._laddered(g, "node_merge", "x", list(range(5000)))
    g.sizes.clear()
    await p._laddered(g, "node_merge", "x", list(range(2000)))
    assert max(g.sizes) <= 700, g.sizes
    # Another kind on the same graph, or the same kind on another graph, starts at the batch size.
    await p._laddered(_Graph(name="other"), "node_merge", "x", list(range(10)))
    assert projection._WIDTHS[("other", "node_merge")].value == 5000


async def test_it_grows_back_by_a_quarter_after_eight_quick_chunks_never_past_the_batch_size():
    g, p = _Graph(), _projector(batch=1000)
    width = p._width(g, "edge_merge")
    width.value = 400
    await p._laddered(g, "edge_merge", "x", list(range(400 * 8)))
    assert width.value == 500
    width.value = 990
    await p._laddered(g, "edge_merge", "x", list(range(990 * 8)))
    assert width.value == 1000


async def test_it_stays_under_a_size_that_failed_until_64_quick_chunks():
    width = projection._Width(5000)
    width.halve(700)                                 # 700 timed out: 350
    for _ in range(8 * 4):
        width.note(100, slow=False)
    assert width.value == 699, width.value           # grew back, but not to 700
    for _ in range(64):
        width.note(100, slow=False)
    assert width.value > 700 and width.failed is None


async def test_a_chunk_that_used_more_than_half_its_budget_halves_the_next(monkeypatch):
    g, p = _Graph(), _projector(batch=1000)
    ticks = iter([0.0, 100.0, 100.0, 100.1])        # the first chunk took 100 s; the next 0.1 s
    monkeypatch.setattr(projection, "_clock", lambda: next(ticks))
    await p._laddered(g, "node_merge", "x", list(range(1500)))
    assert g.sizes == [1000, 500]
    assert p._width(g, "node_merge").value == 500


async def test_a_memory_refusal_is_halved_like_a_timeout():
    g, p = _Graph(limit=10, error="Query's mem consumption exceeded capacity"), _projector()
    await p._laddered(g, "node_merge", "x", list(range(40)))
    assert sorted(g.landed) == list(range(40))


@pytest.mark.parametrize("error", ["Error 111 connecting to localhost:6379. Connection refused.",
                                   "Unknown function 'foo'"])
async def test_a_connection_failure_or_another_error_is_raised_at_once(error, _fresh):
    g, p = _Graph(limit=0, error=error), _projector()
    with pytest.raises(Exception, match=error.split(".")[0][:20]):
        await p._laddered(g, "node_merge", "x", list(range(40)))
    assert g.sizes == [40] and _fresh == []


async def test_one_row_that_still_fails_is_retried_then_handed_to_at_floor(_fresh):
    g, p = _Graph(poison={"7"}), _projector(batch=16)
    handed = []

    async def at_floor(row, exc):
        handed.append((row, str(exc)))
        return True

    landed = []
    await p._laddered(g, "node_delete", "x", [str(i) for i in range(16)], param="urns",
                      at_floor=at_floor, on_result=lambda chunk, _res: landed.extend(chunk))
    assert handed == [("7", "Query timed out")]
    assert sorted(landed, key=int) == [str(i) for i in range(16) if i != 7]
    assert _fresh == [2.0, 4.0, 8.0][:config.PROJECTION_FLOOR_RETRIES]


async def test_one_row_no_one_handles_fails_the_pass():
    g, p = _Graph(poison={"3"}), _projector(batch=8)
    with pytest.raises(Exception, match="Query timed out"):
        await p._laddered(g, "node_delete", "x", [str(i) for i in range(8)], param="urns")


async def test_on_result_and_progress_see_every_chunk_that_landed():
    g, p = _Graph(limit=3), _projector(batch=10)
    seen, counted = [], []

    async def progress(n):
        counted.append(n)

    await p._laddered(g, "edge_merge", "x", list(range(10)),
                      on_result=lambda chunk, res: seen.append((list(chunk), res.result_set[0][0])),
                      progress=progress)
    assert sorted(r for chunk, _n in seen for r in chunk) == list(range(10))
    assert all(len(chunk) == n for chunk, n in seen)
    assert sum(counted) == 10


class _HeldTwice:
    """A key holding ``urn:h`` twice under ``Dataset``, one copy a hub: a ``DETACH DELETE`` of it
    times out while any of its relationships are left, which go ``$k`` at a time."""

    def __init__(self, degree):
        self.rels, self.copies, self.pages = degree, 2, []

    async def query(self, cypher, params=None, timeout=None):
        params = params or {}
        if cypher.endswith("RETURN u, n.gvHash"):                   # the copies the key holds
            return SimpleNamespace(result_set=[["urn:h", "a"], ["urn:h", "b"]][:self.copies])
        if "DETACH DELETE" in cypher:
            assert params["urns"] == ["urn:h"], params
            if self.rels:
                raise Exception("Query timed out")
            self.copies = 0
        elif cypher.startswith("MATCH (n:Dataset {urn: $u}) MATCH (n)-[r]-()"):
            if cypher.endswith("RETURN 1 LIMIT 1"):
                return SimpleNamespace(result_set=[[1]] if self.rels else [])
            self.pages.append(min(self.rels, params["k"]))
            self.rels -= self.pages[-1]
        return SimpleNamespace(result_set=[])


def _rebuilding(monkeypatch, written):
    """A projector whose rebuild reads and writes everything but the deletes through stubs: main
    holds one node, ``urn:h``, and what it writes is recorded in ``written``."""
    monkeypatch.setattr(projection, "_HUB_PAGE", 10)

    @contextlib.asynccontextmanager
    async def session():
        async def get(_model, _key):
            return SimpleNamespace(id="g1")
        yield SimpleNamespace(get=get)

    p = FalkorProjector(graph_client_factory=lambda *_a: None, session_factory=session,
                        batch_size=50)

    async def payloads(_s, refs):
        return {ref[2]: {"urn": "urn:h", "entityType": "Dataset"} for ref in refs}

    async def apply(_client, node_upserts, *_a, **_k):
        written.extend(urn for _eid, urn, _p in node_upserts)
        return 0

    monkeypatch.setattr(p._svc, "_payloads_by_version", payloads)
    monkeypatch.setattr(p, "_apply", apply)
    return p


async def test_a_rebuild_in_place_deletes_a_node_held_twice_whose_copy_is_a_hub(monkeypatch):
    g, written = _HeldTwice(degree=25), []
    p = _rebuilding(monkeypatch, written)

    async def live_count(*_a):
        return 1

    async def expected(*_a):
        return ({("Dataset", "urn:h"): ExpectedNode(entity_id="H", ref=("node", "g1", "v1"),
                                                    fp="a")}, {}, {"urn:h": "Dataset"})

    async def scan(_client):                       # one key, held by two nodes
        held = ("Dataset", "urn:h")
        return {held: ActualNode(fp="a")}, {held: 2}, {}, set(), []

    monkeypatch.setattr(p, "_live_count", live_count)
    monkeypatch.setattr(p, "_expected_projection", expected)
    monkeypatch.setattr(p, "_scan_projection", scan)
    await p._reconcile_in_place(g, "g1", "main1", 5, {})
    assert (g.copies, g.pages, written) == (0, [10, 10, 5], ["urn:h"])


async def test_a_streamed_rebuild_deletes_a_node_held_twice_whose_copy_is_a_hub(monkeypatch):
    g, written = _HeldTwice(degree=25), []
    p = _rebuilding(monkeypatch, written)
    twice = set()
    await p._write_missing(g, None, SimpleNamespace(id="g1"), "main1", 5, "node",
                           [("H", "v1", "c1", "urn:h", "Dataset", None)], {}, None, True, twice)
    assert (g.copies, g.pages, written) == (0, [10, 10, 5], ["urn:h"])
    assert twice == {("Dataset", "urn:h")}


class _Timed(_Graph):
    """Records the budget each statement was sent with."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.budgets: list = []

    async def query(self, cypher, params=None, timeout=None):
        self.budgets.append(timeout)
        return await super().query(cypher, params, timeout)


async def test_a_write_is_cut_off_at_the_ceiling_on_every_mode_and_a_read_is_not():
    g, p = _Timed(), _projector()
    await p._laddered(g, "node_merge", "x", list(range(10)))                     # no cluster here
    assert g.budgets == [1000 * config.PROJECTION_WRITE_CEILING_S]
    g.budgets.clear()
    await p._laddered(g, "node_read", "x", list(range(10)), read_only=True)
    assert g.budgets == [projection._WRITE_TIMEOUT_MS]


async def test_a_chunk_slower_than_the_target_narrows_the_next_never_below_fifty_rows(monkeypatch):
    g, p = _Graph(), _projector(batch=400)
    clock = iter(x * 0.6 for x in range(1000))                  # every statement takes 0.6 s
    monkeypatch.setattr(projection, "_clock", lambda: next(clock))
    await p._laddered(g, "node_merge", "x", list(range(1500)))
    assert g.sizes[:5] == [400, 200, 100, 50, 50], g.sizes
    assert set(g.sizes[3:]) == {50}


async def test_each_write_is_followed_by_a_pause_and_a_longer_one_while_reads_starve(
        monkeypatch, _fresh):
    waits, starving = _fresh, {"now": False}
    g, p = _Graph(), _projector(batch=10)
    took = iter([0, 2.0, 2.0, 4.0, 4.0, 34.0, 34.0, 35.0])      # 2 s, 2 s, 30 s, then a read
    monkeypatch.setattr(projection, "_clock", lambda: next(took))

    async def reads_starving(client):
        return starving["now"]

    monkeypatch.setattr(projection, "_reads_starving", reads_starving)
    await p._laddered(g, "node_merge", "x", list(range(10)))
    starving["now"] = True
    await p._laddered(g, "node_merge", "x", list(range(10)))
    await p._laddered(g, "node_merge", "x", list(range(10)))
    assert waits == [0.5, 4.0, projection._PACE_MAX_S]
    waits.clear()
    await p._laddered(g, "node_read", "x", list(range(10)), read_only=True)     # a read: none
    assert waits == []


def test_the_node_a_client_writes_is_named_as_the_web_tier_names_it():
    from backend.app.providers.falkordb_connection import ResilientGraph

    standalone = SimpleNamespace(mode="single", host="falkor-0", port=6379)
    cluster = SimpleNamespace(mode="cluster", host="seed", port=7000)
    assert projection._node_of(ResilientGraph(None, standalone, "k", None)) == "falkor-0:6379"
    assert projection._node_of(ResilientGraph(None, cluster, "k", None, node=("10.0.0.3", 7001))) \
        == "10.0.0.3:7001"
    assert projection._node_of(ResilientGraph(None, cluster, "k", None)) is None
    assert projection._node_of(_Graph()) is None


async def test_reads_starving_is_asked_of_the_node_once_per_poll_and_fails_open(monkeypatch):
    from backend.app.services.aggregation import redis_client
    from backend.app.providers.falkordb_connection import ResilientGraph

    asked = []

    class _Redis:
        async def get(self, key):
            asked.append(key)
            return "queue_full"

    projection._PRESSURE_SEEN.clear()
    monkeypatch.setattr(redis_client, "get_redis", lambda: _Redis())
    client = ResilientGraph(None, SimpleNamespace(mode="single", host="h", port=1), "k", None)
    assert await projection._reads_starving(client) is True
    assert await projection._reads_starving(client) is True
    assert asked == ["agg:readpressure:h:1"]

    def down():
        raise ConnectionError("no Redis")

    projection._PRESSURE_SEEN.clear()
    monkeypatch.setattr(redis_client, "get_redis", down)
    assert await projection._reads_starving(client) is False
    projection._PRESSURE_SEEN.clear()


async def test_a_pass_holds_its_writing_lease_on_the_endpoint_renewed_not_per_statement(monkeypatch):
    """While it writes, the projector holds ``gvproj:writing:<endpoint>`` (readers' deadline streaks
    there are then answered busy, not as a failover), renewed at most every ten seconds; a read
    holds none, nor does a client that names no endpoint."""
    from backend.app.providers.falkordb_connection import ResilientGraph
    from backend.app.services.aggregation import redis_client

    leased = []

    class _Redis:
        async def set(self, key, value, ex=None):
            leased.append((key, ex))

    class _Writer(ResilientGraph):
        def __init__(self):
            super().__init__(None, SimpleNamespace(mode="single", host="falkor", port=6379), "g",
                             _Graph())
            self.name = "g"

    projection._WRITING_RENEWED.clear()
    monkeypatch.setattr(redis_client, "get_redis", lambda: _Redis())
    p = _projector(batch=10)
    await p._laddered(_Writer(), "node_merge", "x", list(range(30)))           # three statements
    await p._laddered(_Writer(), "node_read", "x", list(range(30)), read_only=True)
    await p._laddered(_Graph(), "node_merge", "x", list(range(30)))
    assert leased == [("gvproj:writing:falkor:6379", projection._WRITING_TTL_S)]
    projection._WRITING_RENEWED.clear()
