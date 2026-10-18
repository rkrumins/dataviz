"""Every writer that advances main takes the graph lock before it reads main, and no lock wait is
unbounded.

* ``_lock_graph`` and ``_lock_branch`` bound their wait (``GRAPHVER_GRAPH_LOCK_TIMEOUT_MS``); a
  wait that runs out (SQLSTATE 55P03) is :class:`LockBusy`, a 503 with Retry-After.
* ``_retry_seq`` retries a lost seq race, a head CAS miss and a busy lock with full-jitter backoff,
  and gives up with :class:`ContentionExhausted`. Any other integrity error is not retried, nor is
  an inner ``_retry_seq`` that gave up already.
* ``_apply_ops_once`` re-reads the graph row after the lock, so the main head it composes against
  is the one the lock holder left.
* revert, restore, sync and the API path of bulk import take the lock, then refuse a graph whose
  enablement has not finished, before they read anything; each is retried. Bulk import into a
  graph created in the same transaction takes no lock. Under the lock they check the graph is
  writable, and a graph that is not is refused, not retried.
* A busy graph reaches the caller as LockBusy through ContextEngine and ``/commands/batch``,
  instead of a ``success: false``; so does a paused one, as GraphNotWritable. Once a batch command has committed, the busy command is a
  ``lock_busy`` result instead and the batch stops, so a retry does not resend what landed.

Pure unit tests: fakes stand in for the session. The same runs on Postgres in
integration/test_versioning_main_lock.py.
"""
import contextlib

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import DBAPIError, IntegrityError

from backend.app.services.versioning import config
from backend.app.services.versioning.errors import ContentionExhausted, GraphNotWritable, LockBusy
from backend.app.services.versioning.models import BranchORM, GraphORM
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService


class _Orig(Exception):
    def __init__(self, sqlstate):
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


class _LockSession:
    """Records each statement; the lock statement (the second) fails with ``fail``."""

    def __init__(self, fail=None):
        self.sql, self._fail = [], fail

    async def execute(self, stmt, params=None):
        self.sql.append((str(stmt.compile(dialect=postgresql.dialect())), params))
        if self._fail is not None and len(self.sql) == 2:
            raise DBAPIError("lock", {}, _Orig(self._fail))
        return self

    def scalar_one_or_none(self):
        return BranchORM(id="d1", graph_id="g1")


_LOCKS = [
    pytest.param(lambda s: GraphVersioningService._lock_graph(s, "g1"), "pg_advisory_xact_lock",
                 id="graph"),
    pytest.param(lambda s: GraphVersioningService._lock_branch(s, "g1", "d1"), "FOR NO KEY UPDATE",
                 id="branch"),
]


@pytest.mark.parametrize("take, lock_sql", _LOCKS)
async def test_the_lock_wait_is_bounded_first(take, lock_sql):
    s = _LockSession()
    await take(s)
    (first, params), (second, _) = s.sql
    assert "set_config('lock_timeout'" in first and params == {"ms": "5000"}
    assert lock_sql in second


@pytest.mark.parametrize("take, _lock_sql", _LOCKS)
async def test_a_lock_wait_that_runs_out_is_lock_busy(take, _lock_sql):
    with pytest.raises(LockBusy) as busy:
        await take(_LockSession(fail="55P03"))
    assert busy.value.status_code == 503 and busy.value.headers == {"Retry-After": "5"}
    with pytest.raises(DBAPIError):                 # anything else is not ours to rename
        await take(_LockSession(fail="40P01"))


# ── _retry_seq ────────────────────────────────────────────────────────────────


@pytest.fixture
def backoff(monkeypatch):
    """The bounds each backoff drew from; no real sleeping."""
    from backend.app.services.versioning import service as svc_mod
    bounds, slept = [], []

    def uniform(lo, hi):
        bounds.append((lo, hi))
        return hi

    async def sleep(secs):
        slept.append(secs)
    monkeypatch.setattr(svc_mod.random, "uniform", uniform)
    monkeypatch.setattr(svc_mod.asyncio, "sleep", sleep)
    monkeypatch.setattr(config, "COMMIT_MAX_RETRIES", 3)
    return bounds


def _thunk(*failures, result="ok"):
    calls = []

    async def fn():
        calls.append(1)
        if len(calls) <= len(failures):
            raise failures[len(calls) - 1]
        return result
    return fn, calls


def _unique_violation():
    return IntegrityError("insert", {}, _Orig("23505"))


async def test_a_busy_lock_is_retried(backoff):
    fn, calls = _thunk(LockBusy(), LockBusy())
    assert await GraphVersioningService()._retry_seq("t", fn) == "ok"
    assert len(calls) == 3
    assert backoff == [(0, 0.02), (0, 0.04)], "full jitter: anywhere from zero to the cap"


@pytest.mark.parametrize("failure", [LockBusy, _unique_violation], ids=["busy", "seq-race"])
async def test_contention_that_never_clears_is_contention_exhausted(backoff, failure):
    fn, calls = _thunk(*(failure() for _ in range(3)))
    with pytest.raises(ContentionExhausted):
        await GraphVersioningService()._retry_seq("t", fn)
    assert len(calls) == 3


async def test_the_backoff_is_capped_at_two_seconds(backoff, monkeypatch):
    monkeypatch.setattr(config, "COMMIT_MAX_RETRIES", 10)
    fn, _ = _thunk(*(LockBusy() for _ in range(9)))
    await GraphVersioningService()._retry_seq("t", fn)
    assert max(hi for _, hi in backoff) == 2.0


async def test_an_inner_retry_that_gave_up_is_not_retried_again(backoff):
    """A publish's checkpoint has its own retries: they are not multiplied by the publish's."""
    fn, calls = _thunk(ContentionExhausted())
    with pytest.raises(ContentionExhausted):
        await GraphVersioningService()._retry_seq("t", fn)
    assert len(calls) == 1


async def test_an_integrity_error_that_is_not_a_seq_race_is_not_retried(backoff):
    fn, calls = _thunk(IntegrityError("insert", {}, _Orig("23502")))    # a not-null
    with pytest.raises(IntegrityError):
        await GraphVersioningService()._retry_seq("t", fn)
    assert len(calls) == 1 and backoff == []


# ── who takes the lock, and when ──────────────────────────────────────────────


class _Stop(Exception):
    pass


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _Session:
    """Records reads in ``events``; ``get`` answers from ``rows``."""

    def __init__(self, events, rows=None):
        self.events, self._rows = events, rows or {}

    async def get(self, model, key):
        self.events.append(f"get {model.__name__}")
        return self._rows.get((model, key))

    async def scalar(self, _stmt):
        self.events.append("scalar")
        return None

    async def refresh(self, obj):
        self.events.append(f"refresh {type(obj).__name__}")


def _spied_svc(monkeypatch, rows=None, lock_failures=(), refuse=None):
    """A service whose sessions record into ``events``; the graph lock, the bootstrap check and
    the lifecycle check are spies, the lock raises ``lock_failures`` in turn on its first calls,
    and the lifecycle check raises ``refuse``."""
    events = []

    @contextlib.asynccontextmanager
    async def session():
        yield _Session(events, rows)

    svc = GraphVersioningService(session_factory=session)
    failures = list(lock_failures)

    async def lock(s, gid):
        events.append("lock")
        if failures:
            raise failures.pop(0)

    async def not_bootstrapping(s, gid):
        events.append("not bootstrapping")

    async def writable(s, gid):
        events.append("writable")
        if refuse is not None:
            raise refuse

    async def nothing(*_a, **_k):
        return None
    monkeypatch.setattr(svc, "_lock_graph", lock)
    monkeypatch.setattr(svc, "_assert_not_bootstrapping", not_bootstrapping)
    monkeypatch.setattr(svc, "_assert_writable", writable)
    monkeypatch.setattr(svc, "_assert_syncable", nothing)
    monkeypatch.setattr("backend.app.services.versioning.service.asyncio.sleep", nothing)
    return svc, events


async def test_a_main_write_rereads_the_graph_after_the_lock(monkeypatch):
    """The graph row was loaded before the lock; a writer that held it may have moved main."""
    rows = {(GraphORM, "g1"): GraphORM(id="g1"), (BranchORM, "main1"): BranchORM(id="main1", kind="main")}
    svc, events = _spied_svc(monkeypatch, rows)

    async def main_bid(s, gid):
        return "main1"

    async def expand(s, gid, bid, ops, cset):
        events.append("expand moves")
        return list(ops)

    async def stop(*_a, **_k):
        raise _Stop
    monkeypatch.setattr(svc, "_main_branch_id", main_bid)
    monkeypatch.setattr(svc, "_expand_moves", expand)
    monkeypatch.setattr(svc, "_current_values", stop)
    with pytest.raises(_Stop):
        await svc.apply_ops(graph_id="g1", actor="u",
                            ops=[{"op": "delete", "entity_id": "n1", "entity_kind": "node"}])
    after_lock = events[events.index("lock"):]
    assert after_lock[:2] == ["lock", "refresh GraphORM"], events
    assert after_lock.index("refresh GraphORM") < after_lock.index("expand moves")


_ADVANCERS = [
    pytest.param(lambda svc: svc.revert_commit(graph_id="g1", commit_id="c1", actor="u"), id="revert"),
    pytest.param(lambda svc: svc.restore_to_commit(graph_id="g1", commit_id="c1", actor="u"), id="restore"),
    pytest.param(lambda svc: svc.sync_ingest(graph_id="g1", rows=[], actor="u"), id="sync"),
    pytest.param(lambda svc: svc.bulk_ingest(graph_id="g1", rows=[], actor="u"), id="bulk"),
]


@pytest.mark.parametrize("advance", _ADVANCERS)
async def test_main_advancers_lock_then_check_enablement_before_reading(monkeypatch, advance):
    svc, events = _spied_svc(monkeypatch)
    with pytest.raises(ValueError, match="unknown graph"):     # the graph read finds nothing
        await advance(svc)
    assert events[:3] == ["lock", "not bootstrapping", "get GraphORM"], events


@pytest.mark.parametrize("advance", _ADVANCERS)
async def test_main_advancers_are_retried(monkeypatch, advance):
    svc, events = _spied_svc(monkeypatch, lock_failures=[_unique_violation(), LockBusy()])
    with pytest.raises(ValueError, match="unknown graph"):
        await advance(svc)
    assert events.count("lock") == 3, events


@pytest.mark.parametrize("advance", _ADVANCERS)
async def test_main_advancers_check_the_lifecycle_under_the_lock(monkeypatch, advance):
    rows = {(GraphORM, "g1"): GraphORM(id="g1", main_head_commit_seq=3)}
    svc, events = _spied_svc(monkeypatch, rows, refuse=GraphNotWritable("frozen"))

    async def main_bid(s, gid):
        return "main1"
    monkeypatch.setattr(svc, "_main_branch_id", main_bid)
    with pytest.raises(GraphNotWritable) as refused:
        await advance(svc)
    assert refused.value.state == "frozen"
    assert events.index("lock") < events.index("writable"), events
    assert events.count("lock") == 1, "a paused graph is not retried"


async def test_a_seed_inside_the_creating_transaction_takes_no_lock(monkeypatch):
    svc, events = _spied_svc(monkeypatch)
    with pytest.raises(ValueError, match="unknown graph"):
        await svc.bulk_ingest(graph_id="g1", rows=[], actor="u", session=_Session(events))
    assert not {"lock", "not bootstrapping", "writable"} & set(events)


async def test_bulk_import_through_the_api_refuses_a_graph_that_has_entities(monkeypatch):
    rows = {(GraphORM, "g1"): GraphORM(id="g1", main_head_commit_seq=3)}
    svc, events = _spied_svc(monkeypatch, rows)

    async def main_bid(s, gid):
        return "main1"
    monkeypatch.setattr(svc, "_main_branch_id", main_bid)

    async def live(_stmt):
        events.append("scalar")
        return "urn:some:entity"
    monkeypatch.setattr(_Session, "scalar", lambda self, stmt: live(stmt))
    with pytest.raises(ConcurrencyError, match="empty graph"):
        await svc.bulk_ingest(graph_id="g1", rows=[{"kind": "node", "entityType": "T"}], actor="u")


# ── a busy graph reaches the caller ───────────────────────────────────────────


class _BusyProvider:
    def __init__(self, exc):
        self.exc = exc

    async def get_node(self, urn):
        from backend.app.models.graph import GraphNode
        return GraphNode(urn=urn, entityType="dataset", displayName=urn)

    async def create_node(self, *_a, **_k):
        raise self.exc

    async def create_edge(self, *_a, **_k):
        raise self.exc

    async def update_edge(self, *_a, **_k):
        raise self.exc

    async def delete_edge(self, *_a, **_k):
        raise self.exc


def _busy_engine(monkeypatch, exc):
    from backend.app.ontology import mutation_validator
    from backend.app.services.context_engine import ContextEngine
    engine = ContextEngine(provider=_BusyProvider(exc))

    async def no_ontology():
        return None
    monkeypatch.setattr(engine, "_get_resolved_ontology", no_ontology)
    for name in ("validate_node_mutation", "validate_edge_mutation"):
        monkeypatch.setattr(mutation_validator, name,
                            lambda *_a, **_k: mutation_validator.MutationResult.success())
    return engine


@pytest.mark.parametrize("exc", [LockBusy(), ContentionExhausted(), GraphNotWritable("frozen")],
                         ids=["busy", "exhausted", "paused"])
async def test_context_engine_writes_let_a_busy_graph_through(monkeypatch, exc):
    from backend.app.models.graph import CreateNodeRequest
    from backend.common.models.graph import CreateEdgeRequest, UpdateEdgeRequest

    engine = _busy_engine(monkeypatch, exc)
    with pytest.raises(type(exc)):
        await engine.create_node(CreateNodeRequest(entityType="dataset", displayName="n"))
    with pytest.raises(type(exc)):
        await engine.create_edge(CreateEdgeRequest(sourceUrn="a", targetUrn="b", edgeType="RELATED_TO"))
    with pytest.raises(type(exc)):
        await engine.update_edge("e1", UpdateEdgeRequest(properties={"w": 1}))


@pytest.mark.parametrize("exc", [LockBusy(), GraphNotWritable("frozen")], ids=["busy", "paused"])
@pytest.mark.parametrize("op, payload", [
    ("create_node", {"entityType": "dataset", "displayName": "n"}),
    ("delete_edge", {"edgeId": "e1"}),
])
async def test_a_batch_lets_a_busy_graph_through(monkeypatch, op, payload, exc):
    from backend.app.api.v1.endpoints.graph import batch_commands
    from backend.common.models.graph import BatchCommandRequest

    engine = _busy_engine(monkeypatch, exc)
    with pytest.raises(type(exc)):
        await batch_commands(request=BatchCommandRequest(commands=[{"op": op, "payload": payload}]),
                             _=None, engine=engine)


class _BusyAfterFirstProvider(_BusyProvider):
    """The first create_node commits; every later write finds the graph busy."""

    def __init__(self, exc):
        super().__init__(exc)
        self.created = 0

    async def create_node(self, *_a, **_k):
        if self.created:
            raise self.exc
        self.created += 1
        return True


@pytest.mark.parametrize("fail_fast", [True, False])
async def test_a_batch_busy_after_a_commit_reports_what_landed(monkeypatch, fail_fast):
    from backend.app.api.v1.endpoints import graph as graph_ep
    from backend.common.models.graph import BatchCommandRequest

    engine = _busy_engine(monkeypatch, LockBusy())
    engine.provider = _BusyAfterFirstProvider(LockBusy())
    invalidated = []

    async def invalidate(e):
        invalidated.append(e)
    monkeypatch.setattr(graph_ep, "_invalidate_cache", invalidate)
    node = {"op": "create_node", "payload": {"entityType": "dataset", "displayName": "n"}}
    resp = await graph_ep.batch_commands(
        request=BatchCommandRequest(commands=[node, node, node], failFast=fail_fast),
        _=None, engine=engine)
    assert [r.success for r in resp.results] == [True, False, False]
    assert resp.results[0].created_urn
    assert resp.results[1].error.startswith("lock_busy")
    assert resp.results[2].error.startswith("Skipped")
    assert (resp.succeeded, resp.failed) == (1, 1)
    assert invalidated == [engine]
