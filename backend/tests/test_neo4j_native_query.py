"""Native queries on Neo4j, against a fake driver: a READ session, one
unmanaged transaction (so the driver never retries it), Neo4j's own plan
asked first whether the query only reads — anything else never runs — only
as many rows pulled as the cap, and always rolled back.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from neo4j.exceptions import Neo4jError, ServiceUnavailable

from backend.common.interfaces.native_query import (
    NativeQueryError,
    NativeQuerySyntaxError,
    NativeQueryTimeout,
    NativeQueryTooLarge,
    NativeQueryWriteRefused,
)
from backend.graph.adapters.neo4j_provider import Neo4jProvider


def neo4j_error(code, message):
    return Neo4jError._hydrate_neo4j(code=code, message=message)


class Record:
    def __init__(self, *values):
        self._values = list(values)

    def values(self):
        return self._values


class Result:
    def __init__(self, keys=(), records=(), query_type="r"):
        self._keys, self._records, self.query_type = tuple(keys), list(records), query_type
        self.fetched = None

    def keys(self):
        return self._keys

    async def fetch(self, n):
        self.fetched = n
        return self._records[:n]

    async def consume(self):
        return SimpleNamespace(query_type=self.query_type)


class Script:
    """How the fake database answers: the plan's query type, the rows, and
    any error at each step."""

    def __init__(self, *, query_type="r", keys=("x",), records=(), explain_error=None,
                 run_error=None, hang=False):
        self.query_type, self.keys, self.records = query_type, keys, records
        self.explain_error, self.run_error, self.hang = explain_error, run_error, hang
        self.runs, self.results, self.closed, self.session_config, self.timeout = [], [], 0, None, None


class Transaction:
    def __init__(self, script):
        self.script = script

    async def run(self, query):
        script = self.script
        script.runs.append(query)
        if query.startswith("EXPLAIN "):
            if script.explain_error:
                raise script.explain_error
            return Result(query_type=script.query_type)
        if script.hang:
            await asyncio.sleep(10)
        if script.run_error:
            raise script.run_error
        result = Result(script.keys, script.records)
        script.results.append(result)
        return result

    async def close(self):
        self.script.closed += 1


class Session:
    def __init__(self, script):
        self.script = script

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def begin_transaction(self, timeout=None):
        self.script.timeout = timeout
        return Transaction(self.script)


class Driver:
    def __init__(self, script):
        self.script = script

    def session(self, **config):
        self.script.session_config = config
        return Session(self.script)


def provider_with(script):
    provider = Neo4jProvider(uri="bolt://neo4j.internal:7687", database="graph")
    provider._driver = Driver(script)
    return provider


async def run(provider, query="MATCH (n) RETURN n.x AS x LIMIT 3", **kwargs):
    args = dict(row_cap=3, timeout_ms=5000, max_reply_bytes=1 << 20)
    args.update(kwargs)
    return await provider.run_readonly_cypher(query, **args)


async def test_a_read_runs_in_a_read_session_and_pulls_only_the_cap():
    script = Script(records=[Record(i) for i in range(10)])
    answer = await run(provider_with(script))
    assert answer.columns == ["x"] and answer.rows == [[0], [1], [2]]
    assert script.session_config == {"database": "graph", "default_access_mode": "READ",
                                     "fetch_size": 3}
    assert script.results[0].fetched == 3
    assert script.timeout == 5.0
    assert script.runs == ["EXPLAIN MATCH (n) RETURN n.x AS x LIMIT 3",
                           "MATCH (n) RETURN n.x AS x LIMIT 3"]


async def test_it_is_always_rolled_back():
    script = Script()
    await run(provider_with(script))
    failing = Script(run_error=neo4j_error("Neo.ClientError.Statement.TypeError", "Type mismatch"))
    with pytest.raises(NativeQueryError):
        await run(provider_with(failing))
    assert script.closed == 1 and failing.closed == 1


@pytest.mark.parametrize("query_type", ["rw", "w", "s"])
async def test_a_plan_that_writes_never_runs(query_type):
    script = Script(query_type=query_type)
    with pytest.raises(NativeQueryWriteRefused):
        await run(provider_with(script))
    assert script.runs == ["EXPLAIN MATCH (n) RETURN n.x AS x LIMIT 3"]
    assert script.closed == 1


async def test_a_syntax_error_points_into_the_query_not_the_explain():
    error = neo4j_error(
        "Neo.ClientError.Statement.SyntaxError",
        "Invalid input 'RETRUN': expected an expression (line 1, column 19 (offset: 18))\n"
        "\"EXPLAIN MATCH (n) RETRUN n\"\n                  ^")
    with pytest.raises(NativeQuerySyntaxError) as caught:
        await run(provider_with(Script(explain_error=error)), query="MATCH (n) RETRUN n")
    assert caught.value.position == 10
    assert str(caught.value) == "Invalid input 'RETRUN': expected an expression (line 1, column 11)"


@pytest.mark.parametrize("code, error", [
    ("Neo.ClientError.Statement.AccessMode", NativeQueryWriteRefused),
    ("Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration", NativeQueryTimeout),
    ("Neo.TransientError.General.MemoryPoolOutOfMemoryError", NativeQueryTooLarge),
    ("Neo.ClientError.Procedure.ProcedureNotFound", NativeQueryError),
])
async def test_what_neo4j_says_about_the_query_reaches_the_person(code, error):
    with pytest.raises(error) as caught:
        await run(provider_with(Script(run_error=neo4j_error(code, "the query's own problem"))))
    assert type(caught.value) is error


async def test_an_error_about_the_database_is_not_dressed_as_the_querys():
    failure = neo4j_error("Neo.DatabaseError.General.UnknownError", "disk")
    with pytest.raises(Neo4jError) as caught:
        await run(provider_with(Script(run_error=failure)))
    assert not isinstance(caught.value, NativeQueryError)


async def test_a_lost_connection_resets_the_driver_and_is_not_retried():
    script = Script(run_error=ServiceUnavailable("gone"))
    provider = provider_with(script)
    with pytest.raises(ServiceUnavailable):
        await run(provider)
    assert provider._driver is None
    assert len([q for q in script.runs if not q.startswith("EXPLAIN")]) == 1


async def test_a_query_that_never_answers_times_out():
    script = Script(hang=True)
    with pytest.raises(NativeQueryTimeout):
        await run(provider_with(script), timeout_ms=1, row_cap=1)
    assert script.closed == 1
