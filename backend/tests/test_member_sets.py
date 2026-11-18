"""Member sets — a scope resolved in full, a step at a time, by whichever request holds it.

The graph is the membership resolver's (``tests/fixtures/membership_graph.py``). The
set's rows live in a file-backed SQLite database, so sessions get connections of their
own and a rollback really undoes (see ``test_auth_revocation_durability.py``): what is
tested here is what survives between requests — a step taken by one "replica" and the
next by another, a step fenced out because its lease was taken over.
"""
import asyncio
import json
import time

import pytest
import pytest_asyncio
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.db.engine import Base
from backend.app.db.models import MemberSetEdgeORM, MemberSetORM, MemberSetRowORM
from backend.app.services.deep_search import CompileError
from backend.app.services.graph_cache import CacheScope
from backend.app.services.member_sets import stepper, sweeper
from backend.app.services.member_sets import store as sets
from backend.app.services.view_membership import resolve_membership
from backend.app.services.view_membership_search import make_seed_pages
from backend.common.models.graph import GraphNode
from backend.common.models.search import SearchHit, SearchResultPage
from backend.common.models.view_membership import MembershipSpec
from backend.tests.fixtures.membership_graph import FakeEngine

SCOPE = CacheScope(workspace_id="ws", data_source_id="ds", graph_ns="g")


@pytest_asyncio.fixture()
async def maker(tmp_path):
    """Sessions with connections of their own, over one database file."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'sets.db'}")
    agg_path = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _connect(dbapi_conn, _record):
        dbapi_conn.execute(f"ATTACH DATABASE '{agg_path}' AS aggregation")
        dbapi_conn.isolation_level = None   # real transactions: a rollback undoes

    @event.listens_for(engine.sync_engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(bind=engine, expire_on_commit=False)
    await engine.dispose()


def spec(urns=None, query=None, **expand):
    seeds = {"urns": urns} if urns is not None else {"query": query}
    return MembershipSpec.model_validate({"seeds": seeds, "expand": expand})


async def new_set(maker, scope_spec, *, include_edges=False, key=None):
    async with maker() as session:
        ms = await sets.open_set(
            session, key=key or scope_spec.spec_hash(), workspace_id="ws", data_source_id="ds",
            spec=json.dumps(scope_spec.model_dump(mode="json", by_alias=True, exclude_none=True)),
            spec_hash=scope_spec.spec_hash(), data_version="1", include_edges=include_edges)
        await session.commit()
        return ms.id


async def run_to_end(maker, set_id, engine, *, owner="a", seed_pages=None):
    """Requests, one after another, until the set is no longer running."""
    for _ in range(500):
        async with maker() as session:
            await stepper.advance(session, set_id, engine, owner=owner, wait_s=60, seed_pages=seed_pages)
            ms = await sets.get(session, set_id)
            await session.commit()
        if ms.status != "running":
            return ms
    raise AssertionError("the set never finished")


async def rows_of(maker, set_id):
    async with maker() as session:
        rows = (await session.execute(
            select(MemberSetRowORM).where(MemberSetRowORM.set_id == set_id))).scalars().all()
    return {r.urn: r for r in rows}


def as_members(rows):
    """What a resolution lists: each member, why, and its distance for that reason."""
    def hops(r):
        return r.hops_up if r.via == "upstream" else r.hops_down if r.via == "downstream" else None
    return {u: (r.via, hops(r)) for u, r in rows.items()}


# ── The same answer a Narrow gives ──────────────────────────────────────────

SPECS = [
    spec(["col_a1"], upstream="all", downstream="all"),
    spec(["tbl_a"], upstream="all", downstream=1, children=1),       # container seed, paged contents
    spec(["col_a2"], upstream=2),                                     # a hub, paged
    spec(["tbl_b"], upstream=1, partnerChildren=1),
    spec(["dom", "ghost"], children=2, upstream="all", downstream="all", partnerChildren="all"),
]


@pytest.mark.parametrize("step_max", [1, 3, 25])
@pytest.mark.parametrize("scope_spec", SPECS, ids=lambda s: s.spec_hash()[:8])
async def test_a_set_holds_what_a_narrow_answers(maker, step_max, scope_spec):
    expected = await resolve_membership(FakeEngine(step_max=step_max, seed_page=1), scope_spec)
    set_id = await new_set(maker, scope_spec)
    ms = await run_to_end(maker, set_id, FakeEngine(step_max=step_max, seed_page=1))

    rows = await rows_of(maker, set_id)
    assert ms.status == "complete" and ms.stage == "done"
    assert as_members(rows) == {m.urn: (m.via, m.hops) for m in expected.members}
    assert sorted(u for u, r in rows.items() if r.whole) == expected.whole_subtree
    assert json.loads(ms.counts) == expected.counts.model_dump(by_alias=True)
    assert json.loads(ms.state).get("missing", 0) == expected.missing_seeds
    assert sorted(r.seq for r in rows.values()) == list(range(len(rows)))


async def test_each_member_knows_the_seed_it_is_nearest(maker):
    set_id = await new_set(maker, spec(["col_a1", "col_a2"], upstream="all"))
    await run_to_end(maker, set_id, FakeEngine(step_max=1))
    rows = await rows_of(maker, set_id)
    assert {u: r.nearest_seed for u, r in rows.items()} == {
        "col_a1": "col_a1", "src1": "col_a1", "src2": "col_a1", "src3": "col_a1",
        "col_a2": "col_a2", "hub": "col_a2", **{f"u{i}": "col_a2" for i in range(1, 6)},
    }


# ── Any replica takes the next step ─────────────────────────────────────────


async def test_a_step_taken_by_one_replica_is_continued_by_another(maker):
    scope_spec = spec(["tbl_a"], upstream="all", downstream="all", children=1)
    straight = await new_set(maker, scope_spec, key="straight")
    await run_to_end(maker, straight, FakeEngine(step_max=1, seed_page=1))

    resumed = await new_set(maker, scope_spec, key="resumed")
    for _ in range(4):   # replica a takes a few steps, then is gone without letting go
        async with maker() as session:
            assert await sets.take_lease(session, resumed, "a")
            ms = await sets.get(session, resumed)
            assert await stepper._one_step(session, ms, FakeEngine(step_max=1, seed_page=1), "a", None, None)
    async with maker() as session:
        held = await sets.get(session, resumed)
        await session.commit()
    assert held.lease_owner == "a" and held.step == 4
    async with maker() as session:
        assert await stepper.advance(session, resumed, FakeEngine(), owner="b", wait_s=5) == "held"
        # ... until its lease runs out.
        await session.execute(update(MemberSetORM).values(lease_until="2000-01-01T00:00:00+00:00"))
        await session.commit()

    await run_to_end(maker, resumed, FakeEngine(step_max=1, seed_page=1), owner="b")
    assert as_members(await rows_of(maker, resumed)) == as_members(await rows_of(maker, straight))


async def test_a_request_waits_on_the_holder_and_takes_over_when_it_lets_go(maker):
    set_id = await new_set(maker, spec(["col_a1"], upstream="all"))
    async with maker() as session:
        assert await sets.take_lease(session, set_id, "a")

    started = time.monotonic()
    async with maker() as session:
        await stepper.drive(session, set_id, FakeEngine(), owner="b", wait_s=0.6)
        ms = await sets.get(session, set_id)
        await session.commit()
    assert time.monotonic() - started >= 0.6
    assert (ms.step, ms.status) == (0, "running")         # answered with how far it got

    async def let_go_soon():
        await asyncio.sleep(0.3)
        async with maker() as session:
            await sets.release_lease(session, set_id, "a")

    async with maker() as session:
        await asyncio.gather(let_go_soon(),
                             stepper.drive(session, set_id, FakeEngine(), owner="b", wait_s=10))
        ms = await sets.get(session, set_id)
    assert ms.status == "complete"


class _CrashOnce(FakeEngine):
    """A graph call that is answered, and then the process dies before the step commits."""

    def __init__(self, at, **kw):
        super().__init__(**kw)
        self.at = at

    async def trace_closure(self, req):
        result = await super().trace_closure(req)
        if len(self.closure_calls) == self.at:
            raise RuntimeError("the process died here")
        return result


async def test_a_step_that_never_committed_is_taken_again_and_writes_once(maker):
    scope_spec = spec(["col_a1"], upstream="all", downstream="all")
    straight = await new_set(maker, scope_spec, key="straight")
    await run_to_end(maker, straight, FakeEngine(step_max=1))

    crashed = await new_set(maker, scope_spec, key="crashed")
    engine = _CrashOnce(3, step_max=1)
    with pytest.raises(RuntimeError):
        await run_to_end(maker, crashed, engine)
    ms = await run_to_end(maker, crashed, engine)
    assert ms.status == "complete"
    assert as_members(await rows_of(maker, crashed)) == as_members(await rows_of(maker, straight))


class _TakenOverMidStep(FakeEngine):
    """While this step's graph call runs, its lease runs out and another request takes
    the set over and moves it on. This step also finds something only it found."""

    def __init__(self, maker, set_id, **kw):
        super().__init__(**kw)
        self.maker, self.set_id = maker, set_id

    async def trace_closure(self, req):
        result = await super().trace_closure(req)
        async with self.maker() as session:
            await session.execute(update(MemberSetORM).values(lease_until="2000-01-01T00:00:00+00:00"))
            await session.commit()
        async with self.maker() as session:
            assert await sets.take_lease(session, self.set_id, "b")
            ms = await sets.get(session, self.set_id)
            assert await stepper._one_step(session, ms, FakeEngine(), "b", None, None)
        result.upstream_urns = result.upstream_urns | {"only_a"}
        return result


async def test_a_step_whose_lease_was_taken_over_writes_nothing(maker):
    set_id = await new_set(maker, spec(["col_a1"], upstream="all"))
    for _ in range(3):   # the seeds, nothing inside, the walk's start
        async with maker() as session:
            await sets.take_lease(session, set_id, "a")
            assert await stepper._one_step(session, await sets.get(session, set_id), FakeEngine(), "a", None, None)

    async with maker() as session:
        ms = await sets.get(session, set_id)
        assert ms.stage == "upstream"
        engine = _TakenOverMidStep(maker, set_id)
        assert not await stepper._one_step(session, ms, engine, "a", None, None)

    rows = await rows_of(maker, set_id)
    assert "only_a" not in rows
    assert {"src1", "src2", "src3"} <= set(rows)      # b's step stands
    async with maker() as session:
        ms = await sets.get(session, set_id)
    assert (ms.lease_owner, ms.step) == ("b", 4)


# ── Limits, said ────────────────────────────────────────────────────────────


async def test_a_step_that_times_out_halves_then_lets_go_and_says_so(maker):
    engine = FakeEngine(step_gives_up="timeout")
    set_id = await new_set(maker, spec(["col_a1", "rep1", "src1"], upstream=1))
    ms = await run_to_end(maker, set_id, engine)

    assert [len(r.seed_urns) for r in engine.closure_calls] == [3] + [1] * 9
    assert [t["reason"] for t in json.loads(ms.truncated)] == ["incomplete"]
    assert ms.status == "complete"
    assert {"src2", "src1", "col_a1"} <= set(await rows_of(maker, set_id))   # what it found is kept


async def test_the_member_cap_completes_the_set_and_says_so(maker, monkeypatch):
    monkeypatch.setattr(stepper, "MEMBER_SET_MAX_MEMBERS", 3)
    set_id = await new_set(maker, spec(["dom"], children=2))
    ms = await run_to_end(maker, set_id, FakeEngine())
    assert len(await rows_of(maker, set_id)) == 3
    assert [(t["reason"], t["limit"]) for t in json.loads(ms.truncated)] == [("member_cap", 3)]
    assert ms.status == "complete"


async def test_edges_between_members_are_kept_up_to_their_cap(maker, monkeypatch):
    set_id = await new_set(maker, spec(["col_a1"], upstream="all"), include_edges=True)
    await run_to_end(maker, set_id, FakeEngine(step_max=1))
    async with maker() as session:
        edges = (await session.execute(select(MemberSetEdgeORM))).scalars().all()
    assert {(e.source_urn, e.target_urn) for e in edges} == {
        ("src1", "col_a1"), ("src2", "src1"), ("src3", "src2")}

    monkeypatch.setattr(stepper, "MEMBER_SET_MAX_EDGES", 2)
    capped = await new_set(maker, spec(["col_a1"], upstream="all"), include_edges=True, key="capped")
    ms = await run_to_end(maker, capped, FakeEngine(step_max=1))
    assert ms.edge_count == 2
    assert [t["reason"] for t in json.loads(ms.truncated)] == ["edge_cap"]
    assert len(await rows_of(maker, capped)) == 4      # its members go on


async def test_a_set_that_runs_past_its_time_completes_and_says_so(maker, monkeypatch):
    monkeypatch.setattr(stepper, "MEMBER_SET_MAX_DURATION_S", -1)
    set_id = await new_set(maker, spec(["col_a1"], upstream="all"))
    ms = await run_to_end(maker, set_id, FakeEngine())
    assert ms.status == "complete" and [t["reason"] for t in json.loads(ms.truncated)] == ["deadline"]


# ── A query seed's every match ──────────────────────────────────────────────


class _Search:
    """A search with more matches than one page holds: pages of 5,000 by cursor, the
    second page still running when first asked, and a cursor that stops reading once."""

    def __init__(self, total):
        self.urns = [f"m{i:05d}" for i in range(total)]
        self.calls = []
        self.expired_once = False

    async def search(self, query, *, run_context=None):
        opts = query.options
        self.calls.append((opts.cursor, opts.session_id))
        offset = int(opts.cursor[2:]) if opts.cursor else 0
        if offset == 5000 and not opts.session_id:
            return SearchResultPage(elapsedMs=1, status="running", sessionId="s2"), None
        if offset == 10000 and not self.expired_once:
            self.expired_once = True
            raise CompileError("cursor was issued for a different query — restart from the first page")
        page = self.urns[offset:offset + opts.page_size]
        more = offset + opts.page_size < len(self.urns)
        hits = [SearchHit(node=GraphNode(urn=u, displayName=u, entityType="thing")) for u in page]
        return SearchResultPage(hits=hits, elapsedMs=1, status="complete",
                                cursor=f"o:{offset + opts.page_size}" if more else None), None


async def test_query_seeds_are_every_match_past_the_narrow_limit(maker):
    from backend.app.services.view_membership_search import seed_query_for

    scope_spec = spec(query={"kind": "text", "value": "m"})
    svc = _Search(12_345)
    pages = make_seed_pages(svc, seed_query_for(scope_spec, "v1"), data_version="1", admit=None)
    set_id = await new_set(maker, scope_spec)
    ms = await run_to_end(maker, set_id, FakeEngine(), seed_pages=pages)

    rows = await rows_of(maker, set_id)
    assert set(rows) == set(svc.urns) and {r.via for r in rows.values()} == {"seed"}
    assert json.loads(ms.counts)["seeds"] == 12_345 and json.loads(ms.truncated) == []
    assert ("o:5000", "s2") in svc.calls                 # a running page is moved on
    assert svc.calls.count((None, None)) == 2             # a cursor that stopped reading restarts


# ── The sweep ───────────────────────────────────────────────────────────────


async def test_the_sweep_expires_what_is_due_and_deletes_it_a_batch_at_a_time(maker):
    done = await new_set(maker, spec(["col_a1"], upstream="all"), include_edges=True, key="done")
    await run_to_end(maker, done, FakeEngine(step_max=1))
    live = await new_set(maker, spec(["col_a1"]), key="live")
    async with maker() as session:
        await session.execute(update(MemberSetORM).where(MemberSetORM.id == done)
                              .values(expires_at="2000-01-01T00:00:00+00:00"))
        await session.commit()

    async def kept():
        async with maker() as session:
            rows = (await session.execute(select(MemberSetRowORM))).scalars().all()
            edges = (await session.execute(select(MemberSetEdgeORM))).scalars().all()
        return len(rows) + len(edges)

    before, passes = await kept(), 0
    while True:
        async with maker() as session:
            n = await sweeper.sweep_once(session, batch=2)
            await session.commit()
        if not n:
            break
        now = await kept()
        assert before - now <= 2          # no pass deletes more than its batch
        before, passes = now, passes + 1
    assert passes >= 4
    async with maker() as session:
        left = {ms.id: ms.status for ms in (await session.execute(select(MemberSetORM))).scalars().all()}
        edges = (await session.execute(select(MemberSetEdgeORM))).scalars().all()
    assert left == {live: "running"}
    assert await rows_of(maker, done) == {} and edges == []


async def test_an_expired_set_frees_its_question_to_be_asked_again(maker):
    first = await new_set(maker, spec(["col_a1"]), key="k")
    async with maker() as session:
        await sets.retire(session, [first])
        await session.commit()
    again = await new_set(maker, spec(["col_a1"]), key="k")
    assert again != first
