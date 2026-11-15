"""Each process reads a versioned graph's route from Postgres once per change to it, not per read
(``versioning.route_cache``).

A route is kept while the graph's token in Redis is the one read before its query: a lookup reads
the token and nothing else, and reads Postgres again once a write has moved it, the route is past
its age, or Redis can't say (then each lookup reads Postgres, as before). Lookups waiting on one
graph's read take it only if it answers them: read since they began, or against the tokens they
read. A data source with no live graph is remembered against the set's token.

The graphver session notes each write to a route's columns, by the unit of work or as an ORM
statement, and its commit announces them; a write that names no graph moves every graph's route.
No database or Redis: the route's query and Redis are stubbed.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import bindparam, delete, insert, select, update

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning import route_cache as rc
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM


class _Redis:
    """Enough of a Redis for the route cache: MGET, and a pipeline of SET (NX, EX) and MGET."""

    def __init__(self):
        self.data, self.down, self.mgets = {}, False, 0

    async def mget(self, keys):
        if self.down:
            raise ConnectionError("redis down")
        self.mgets += 1
        return [self.data.get(k) for k in keys]

    def pipeline(self, transaction=False):
        redis, ops = self, []

        class _Pipe:
            def set(self, key, value, nx=False, ex=None):
                ops.append(("set", key, value, nx))

            def mget(self, keys):
                ops.append(("mget", keys))

            async def execute(self):
                if redis.down:
                    raise ConnectionError("redis down")
                out = []
                for op in ops:
                    if op[0] == "set":
                        if not (op[3] and op[1] in redis.data):
                            redis.data[op[1]] = op[2]
                        out.append(True)
                    else:
                        out.append([redis.data.get(k) for k in op[1]])
                return out
        return _Pipe()


def _route(gid="g1", ds="ds1", **kw):
    fields = dict(graph_id=gid, data_source_id=ds, fork_parent_graph_id=None, root_id=None,
                  deleted=False, main_branch_id="br_main", committed=3, projected=3,
                  served_commit_seq=3, status="idle", read_mode=None, falkor_graph_name="K1",
                  falkor_provider=None, window_rows=None, last_error=None, residency="standard",
                  size_bytes=None)
    fields.update(kw)
    return rc.RouteSnapshot(**fields)


@pytest.fixture
def store(monkeypatch):
    """A stubbed Redis and route query: ``rows`` is what Postgres holds (graph id -> route), and
    ``reads`` each query made."""
    redis = _Redis()
    state = {"rows": {"g1": _route()}, "reads": [], "redis": redis, "gate": None}

    async def _read(graph_id):
        state["reads"].append(graph_id)
        if state["gate"] is not None:
            await state["gate"].wait()
        return state["rows"].get(graph_id)

    async def _read_graph_id(ds):
        state["reads"].append(ds)
        return next((r.graph_id for r in state["rows"].values()
                     if r.data_source_id == ds and not r.deleted), None)

    monkeypatch.setattr(rc, "_read", _read)
    monkeypatch.setattr(rc, "_read_graph_id", _read_graph_id)
    monkeypatch.setattr(rc, "_redis", lambda: redis)
    monkeypatch.setattr(gv_config, "ROUTE_CACHE_SECS", 5.0)
    rc._LOOP.update(loop=None, redis=None)
    yield state
    rc._LOOP.update(loop=None, redis=None)
    rc.reset()


def _run(coro):
    return asyncio.run(coro)


def test_a_route_is_read_once_while_its_token_stands_and_again_once_a_write_moves_it(store):
    async def go():
        first = await rc.route_of_graph("g1")
        for _ in range(20):
            assert await rc.route_of_graph("g1") is first
        assert store["reads"] == ["g1"]
        # Another process publishes: its commit moves the token, and the next lookup reads again.
        store["rows"]["g1"] = _route(committed=4)
        store["redis"].data[rc._key("g1")] = "moved"
        assert (await rc.route_of_graph("g1")).committed == 4
        assert store["reads"] == ["g1", "g1"]
    _run(go())


def test_many_lookups_of_a_moved_route_share_one_read(store):
    async def go():
        await rc.route_of_graph("g1")
        store["redis"].data[rc._key("g1")] = "moved"
        store["gate"] = asyncio.Event()
        lookups = [asyncio.ensure_future(rc.route_of_graph("g1")) for _ in range(50)]
        await asyncio.sleep(0.01)
        store["gate"].set()
        routes = await asyncio.gather(*lookups)
        assert len(store["reads"]) == 2, "one read for the fifty"
        assert len({id(r) for r in routes}) == 1
    _run(go())


def test_a_lookup_that_read_a_newer_token_takes_no_older_read(store):
    async def go():
        await rc.route_of_graph("g1")
        store["redis"].data[rc._key("g1")] = "t2"
        store["gate"] = asyncio.Event()
        early = asyncio.ensure_future(rc.route_of_graph("g1"))     # reads against t2
        await asyncio.sleep(0.01)
        store["rows"]["g1"] = _route(committed=5)
        store["redis"].data[rc._key("g1")] = "t3"                   # a write lands meanwhile
        late = asyncio.ensure_future(rc.route_of_graph("g1"))       # began after it: reads again
        await asyncio.sleep(0.01)
        store["gate"].set()
        await early
        assert (await late).committed == 5
        assert len(store["reads"]) == 3
    _run(go())


def test_with_redis_down_each_lookup_reads_postgres_and_shares_only_a_read_begun_after_it(store):
    async def go():
        store["redis"].down = True
        for n in range(3):
            await rc.route_of_graph("g1")
            assert len(store["reads"]) == n + 1, "nothing is trusted that Redis can't vouch for"
        # Lookups that wait on a read begun before them take the next read, all of them one.
        store["gate"] = asyncio.Event()
        before = len(store["reads"])
        first = asyncio.ensure_future(rc.route_of_graph("g1"))
        await asyncio.sleep(0.01)
        waiting = [asyncio.ensure_future(rc.route_of_graph("g1")) for _ in range(10)]
        await asyncio.sleep(0.01)
        store["gate"].set()
        await asyncio.gather(first, *waiting)
        assert len(store["reads"]) - before == 2
    _run(go())


def test_a_route_past_its_age_is_read_again_whatever_its_token(store, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(rc, "_clock", lambda: clock[0])

    async def go():
        await rc.route_of_graph("g1")
        clock[0] += 4.9
        await rc.route_of_graph("g1")
        assert len(store["reads"]) == 1
        clock[0] += 0.2
        await rc.route_of_graph("g1")
        assert len(store["reads"]) == 2
    _run(go())


def test_off_every_lookup_reads_postgres_and_redis_is_not_asked(store, monkeypatch):
    monkeypatch.setattr(gv_config, "ROUTE_CACHE_SECS", 0)

    async def go():
        for _ in range(3):
            await rc.route_of_graph("g1")
        assert len(store["reads"]) == 3 and store["redis"].mgets == 0
    _run(go())


def test_a_source_with_no_graph_is_remembered_until_a_graph_is_created(store):
    async def go():
        assert await rc.route_of_source("ds_new") is None
        assert await rc.route_of_source("ds_new") is None
        assert store["reads"] == ["ds_new"]
        # A graph is created for it, elsewhere: the set's token moves.
        store["rows"]["g2"] = _route("g2", "ds_new")
        store["redis"].data[rc._SET] = "moved"
        assert (await rc.route_of_source("ds_new")).graph_id == "g2"
        # Its graph named, the route is read against the graph's token, and kept by it.
        await rc.route_of_source("ds_new")
        await rc.route_of_source("ds_new")
        assert store["reads"] == ["ds_new", "ds_new", "g2"]
    _run(go())


def test_a_trashed_graph_leaves_its_source_without_one(store):
    async def go():
        assert (await rc.route_of_source("ds1")).graph_id == "g1"
        store["rows"]["g1"] = _route(deleted=True)
        store["redis"].data[rc._key("g1")] = "moved"
        store["redis"].data[rc._SET] = "moved"
        assert await rc.route_of_source("ds1") is None
    _run(go())


def test_an_announcement_moves_the_tokens_and_this_processes_routes_go_at_once(store):
    async def go():
        await rc.route_of_graph("g1")
        before = dict(store["redis"].data)
        assert await rc.announce(["g1"], graph_set=True)
        assert store["redis"].data[rc._key("g1")] != before[rc._key("g1")]
        assert store["redis"].data[rc._SET] != before.get(rc._SET)
        assert "g1" not in rc._SNAPS
        # Redis can't take it: False, counted, and announcements skip it a moment.
        store["redis"].down = True
        assert await rc.announce(["g1"]) is False
        store["redis"].down = False
        assert await rc.announce(["g1"]) is False, "still backing off"
    _run(go())


def test_every_graphs_token_moves_when_a_write_names_none(store):
    async def go():
        await rc.route_of_graph("g1")
        assert store["reads"] == ["g1"]
        kept = dict(rc._SNAPS)
        await rc.announce(every=True)       # by another process: this one's routes are as they were
        rc._SNAPS.update(kept)
        store["rows"]["g1"] = _route(committed=9)
        assert (await rc.route_of_graph("g1")).committed == 9
    _run(go())


async def _state_of(snap):
    return await snap.state()


def test_its_state_is_what_the_watermark_says_of_the_route(store, monkeypatch):
    from backend.app.services.versioning import build_policy

    async def _policy(session=None):
        return build_policy.defaults()

    monkeypatch.setattr(build_policy, "resolve", _policy)
    behind = _route(committed=5, projected=3, served_commit_seq=3, status="projecting")
    state = _run(_state_of(behind))
    assert state["served"] is None and state["fresh"] is False           # latest: Postgres serves
    state = _run(_state_of(replace(behind, read_mode="in_place")))
    assert state["served"] == 3 and state["read_mode"] == "in_place"     # the version it holds
    assert _run(_state_of(_route()))["served"] == 3


# ── Noting route changes ──────────────────────────────────────────────────────────────────────────
def _executed(stmt, params=None, *, returned=None):
    session = SimpleNamespace(info={})
    kind = stmt.__visit_name__
    state = SimpleNamespace(
        is_update=kind == "update", is_delete=kind == "delete", is_insert=kind == "insert",
        statement=stmt, parameters=params or {}, session=session)
    if returned is not None:
        state.invoke_statement = lambda: SimpleNamespace(
            keys=lambda: ["graph_id"], freeze=lambda: _Frozen(returned))
    out = rc._executed(state)
    return session.info.get(rc._PENDING), out


class _Frozen:
    def __init__(self, ids):
        self.data = [(g,) for g in ids]

    def __call__(self):
        return "its result"


PS = ProjectionStateORM


@pytest.mark.parametrize("stmt, params, graphs", [
    (update(PS).where(PS.graph_id == "g1", PS.epoch == 2).values(status="evicted"), None, {"g1"}),
    (update(PS).where(PS.graph_id.in_(["g1", "g2"])).values(projected_commit_seq=0), None,
     {"g1", "g2"}),
    (update(PS).where(PS.graph_id == bindparam("g")).values(read_mode="beside"), {"g": "g3"},
     {"g3"}),
    (update(GraphORM).where(GraphORM.id == "g4").values(main_head_commit_seq=7), None, {"g4"}),
    (delete(PS).where(PS.graph_id == "g5"), None, {"g5"}),
    (insert(PS).values(graph_id="g6", status="idle"), None, {"g6"}),
])
def test_a_write_to_a_routes_columns_is_noted_by_its_graph(stmt, params, graphs):
    noted, _out = _executed(stmt, params)
    assert noted["graphs"] == graphs and noted["all"] is False


def test_a_write_to_no_column_of_a_route_is_not_noted():
    for stmt in (update(PS).where(PS.graph_id == "g1").values(progress_done=5),
                 update(PS).values(last_read_at="now"),
                 update(GraphORM).where(GraphORM.id == "g1").values(workspace_id="ws2"),
                 select(PS.graph_id)):
        assert _executed(stmt)[0] is None, stmt


def test_which_graphs_are_live_moves_with_a_graph_created_trashed_or_restored():
    assert _executed(update(GraphORM).where(GraphORM.id == "g1")
                     .values(deleted_at=None))[0]["set"] is True
    assert _executed(insert(GraphORM).values(id="g1", data_source_id="d"))[0]["set"] is True
    assert _executed(update(GraphORM).where(GraphORM.id == "g1")
                     .values(main_head_commit_seq=3))[0]["set"] is False


def test_a_write_that_names_no_graph_moves_every_route_unless_it_returns_them():
    by_key = update(PS).where(PS.falkor_graph_name == "K1").values(falkor_graph_name=None)
    noted, _out = _executed(by_key)
    assert noted["all"] is True
    noted, out = _executed(by_key.returning(PS.graph_id), returned=["g7", "g8"])
    assert noted["graphs"] == {"g7", "g8"} and noted["all"] is False
    assert out == "its result", "the statement's own result, as it ran"


def test_notes_are_announced_once_committed_and_never_once_rolled_back():
    sync = SimpleNamespace(info={})
    rc._note(sync, ["g1"], graph_set=False)
    rc._rolled_back(sync)
    assert sync.info == {}
    rc._note(sync, ["g1"], graph_set=False)
    rc._note(sync, None, graph_set=True)
    rc._committed(sync)
    assert sync.info[rc._DONE] == {"graphs": {"g1"}, "set": True, "all": True}


def test_the_unit_of_work_notes_a_changed_route_column_and_nothing_else():
    ps = ProjectionStateORM(graph_id="g1")
    graph = GraphORM(id="g2")
    sync = SimpleNamespace(info={}, new=(), deleted=(), dirty=(ps, graph))
    ps.progress_done = 4
    graph.workspace_id = "ws2"
    rc._flushed(sync, None)
    assert rc._PENDING not in sync.info
    ps.status = "projecting"
    graph.deleted_at = datetime.now(timezone.utc)
    rc._flushed(sync, None)
    assert sync.info[rc._PENDING]["graphs"] == {"g1", "g2"}
    assert sync.info[rc._PENDING]["set"] is True
    fresh = SimpleNamespace(info={}, new=(GraphORM(id="g3", data_source_id="d3"),), deleted=(),
                            dirty=())
    rc._flushed(fresh, None)
    assert fresh.info[rc._PENDING] == {"graphs": {"g3"}, "set": True, "all": False}
