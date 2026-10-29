"""Unit tests for the versioned-data-source bridge.

This is the signal the aggregation reconciliation sweep uses to guard versioned
sources out of every detector, so its failure behaviour is load-bearing: both
fail-open answers are wrong. Assuming nothing is versioned loses the guard and
lets a structural false positive rebuild graphs that may not exist; assuming
everything is versioned silently stops reconciling the fleet. So a refresh
failure serves the last good answer, and only a COLD failure raises — which the
sweep turns into "defer to the next tick".
"""
import asyncio

import pytest
from sqlalchemy.dialects import postgresql

from backend.app.services import versioned_sources as vs


class _Rows:
    def __init__(self, ids):
        self._ids = ids

    def all(self):
        return [(i,) for i in self._ids]


class _Session:
    def __init__(self, ids):
        self._ids = ids

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def execute(self, _stmt):
        return _Rows(self._ids)


def _factory_returning(ids, calls=None):
    def _get_session_factory():
        if calls is not None:
            calls.append(1)
        return lambda: _Session(ids)
    return _get_session_factory


class _EnablingStore(_Session):
    """Two live graphs: ``ds_done``, whose enable job completed, and ``ds_enabling``, whose enable
    job has not. Answers as Postgres would: ``ds_enabling`` is left out only by a statement that
    excludes graphs with an unfinished bootstrap job, correlated to the graph row."""

    def __init__(self, statements):
        super().__init__(None)
        self._statements = statements

    async def execute(self, stmt):
        sql = str(stmt.compile(dialect=postgresql.dialect()))
        self._statements.append(sql)
        sub = sql.partition("NOT (EXISTS")[2]
        unfinished_out = ("FROM graphver.jobs" in sub and "FROM graphver.graphs" not in sub
                          and "jobs.graph_id = graphver.graphs.id" in sub)
        return _Rows(["ds_done"] if unfinished_out else ["ds_done", "ds_enabling"])


@pytest.fixture(autouse=True)
def _clean_cache():
    vs.reset_cache()
    yield
    vs.reset_cache()


def test_returns_the_versioned_ids(monkeypatch):
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        _factory_returning(["ds_1", "ds_2"]),
    )
    assert asyncio.run(vs.versioned_data_source_ids()) == frozenset(
        {"ds_1", "ds_2"}
    )


def test_no_versioned_graphs_is_an_empty_set_not_an_error(monkeypatch):
    """A deployment that never turned versioning on still has the graphver
    tables — the alembic chain creates them — so this is a clean zero-row
    read, not a failure."""
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        _factory_returning([]),
    )
    assert asyncio.run(vs.versioned_data_source_ids()) == frozenset()


def test_the_cache_is_served_within_the_ttl(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        _factory_returning(["ds_1"], calls),
    )

    async def _twice():
        await vs.versioned_data_source_ids()
        await vs.versioned_data_source_ids()

    asyncio.run(_twice())
    assert len(calls) == 1


def test_an_expired_ttl_re_reads(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        _factory_returning(["ds_1"], calls),
    )

    async def _twice():
        await vs.versioned_data_source_ids()
        await vs.versioned_data_source_ids(ttl_secs=0)

    asyncio.run(_twice())
    assert len(calls) == 2


def test_an_unfinished_enable_is_left_out_of_the_finished_set_only(monkeypatch):
    """A ``graphs`` row exists from the moment an enable is queued, so the default set counts a
    graph whose enable is pending, running, paused for a decision or failed. The finished-only set
    leaves it out until its enable completes. The two answers are cached apart."""
    statements: list = []
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        lambda: lambda: _EnablingStore(statements),
    )

    async def _asks():
        return [await vs.versioned_data_source_ids(),
                await vs.versioned_data_source_ids(finished_only=True),
                await vs.versioned_data_source_ids(),
                await vs.versioned_data_source_ids(finished_only=True)]

    every, finished = frozenset({"ds_done", "ds_enabling"}), frozenset({"ds_done"})
    assert asyncio.run(_asks()) == [every, finished, every, finished]
    assert len(statements) == 2, "each set is read once, then served from its own cache"


def test_a_refresh_failure_serves_the_last_good_answer(monkeypatch):
    """The set changes only when a source is versioned or unversioned, so a
    stale read is very nearly always still correct — and far better than
    flipping the whole fleet's classification on a DB blip."""
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        _factory_returning(["ds_1"]),
    )
    assert asyncio.run(vs.versioned_data_source_ids()) == frozenset({"ds_1"})

    def _broken():
        raise RuntimeError("graphver unreachable")

    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory", _broken,
    )
    assert asyncio.run(
        vs.versioned_data_source_ids(ttl_secs=0)
    ) == frozenset({"ds_1"})


def test_a_failed_refresh_is_not_retried_by_every_caller(monkeypatch):
    """The view lists ask on every request. While the store is down, each of
    them must not wait out its own connection attempt: after one failure the
    last good answer is served until the back-off passes, then it tries again."""
    clock = [1000.0]
    monkeypatch.setattr(vs.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory",
        _factory_returning(["ds_1"]),
    )
    assert asyncio.run(vs.versioned_data_source_ids()) == frozenset({"ds_1"})

    attempts: list = []

    def _broken():
        attempts.append(1)
        raise RuntimeError("graphver unreachable")

    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory", _broken,
    )

    async def _calls(n):
        return [await vs.versioned_data_source_ids(ttl_secs=0) for _ in range(n)]

    assert asyncio.run(_calls(3)) == [frozenset({"ds_1"})] * 3
    assert len(attempts) == 1

    clock[0] += vs.FAILURE_BACKOFF_SECS + 1
    assert asyncio.run(_calls(1)) == [frozenset({"ds_1"})]
    assert len(attempts) == 2


def test_a_cold_failure_raises_so_the_caller_can_defer(monkeypatch):
    def _broken():
        raise RuntimeError("graphver unreachable")

    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory", _broken,
    )
    with pytest.raises(vs.VersionedLookupUnavailable):
        asyncio.run(vs.versioned_data_source_ids())


def test_cancellation_is_never_swallowed(monkeypatch):
    """``CancelledError`` is a BaseException, but a bare ``except Exception``
    ordering mistake here would still convert a shutdown into a cold-failure
    raise and mask it."""
    def _cancelled():
        raise asyncio.CancelledError()

    monkeypatch.setattr(
        "backend.app.services.versioning.db.get_session_factory", _cancelled,
    )
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(vs.versioned_data_source_ids())
