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
