"""Tests for the executor seam: ``FalkorDBExecutor`` over the five query
chokepoints (``_ro_query`` / ``_query`` / ``_ro_query_tolerant`` /
``_proj_ro_query`` / ``_proj_query``), and ``CypherResult``'s lazy,
defensive ``columns``.

No production call site routes through the executor yet -- this task adds
the layer and proves it is equivalent to calling a chokepoint directly.
The interception test below is the point of the whole design: the unit
suite fakes the database by assigning over a provider's own methods on a
live instance (``p._ro_query = fake``, 26 sites elsewhere in this suite;
``_proj_ro_query``, 23; ``_query``, 9; ``_proj_query``, 4), which only
works because these are plain instance methods a plain attribute
assignment can shadow. ``FalkorDBExecutor`` must look each chokepoint up
on the owner AT CALL TIME rather than capture a bound method at
construction, or every one of those sites would silently start
exercising the real code path while still reporting green.
"""
import types

import pytest

from backend.app.providers.falkordb import FalkorDBProvider
from backend.app.providers.falkordb.errors import _EmptyResult
from backend.app.providers.falkordb.executor import FalkorDBExecutor
from backend.common.providers.cypher.executor import CypherResult


def _provider():
    """A normally-constructed provider, never connected to a real database."""
    return FalkorDBProvider(host="x", graph_name="g")


class _Res:
    """Driver-result stand-in: a distinct ``result_set`` list, plus an
    optional FalkorDB-shaped header (``[type, name]`` pairs)."""

    def __init__(self, rows, header=None):
        self.result_set = rows
        if header is not None:
            self.header = header


# ---------------------------------------------------------------------------
# CypherResult -- result_set identity, and columns is lazy + defensive.
# ---------------------------------------------------------------------------


def test_result_set_is_the_drivers_own_list():
    raw = _Res([[1, "a"], [2, "b"]])
    result = CypherResult(raw=raw, result_set=raw.result_set)
    assert result.result_set is raw.result_set


def test_columns_on_empty_result_is_empty_tuple_and_does_not_raise():
    """The tolerant read path's missing-graph stand-in (``_EmptyResult``)
    has no ``.header`` at all -- a normal state (the graph key doesn't
    exist yet), not an error. An eager ``raw.header`` read would crash
    exactly here; the lazy, defensive property must not.
    """
    raw = _EmptyResult()
    result = CypherResult(raw=raw, result_set=raw.result_set)
    assert result.columns == ()
    assert result.result_set == []


def test_columns_reads_the_drivers_header_lazily():
    raw = _Res([["Alice", "urn:1"], ["Bob", "urn:2"]], header=[[1, "n.name"], [1, "n.urn"]])
    result = CypherResult(raw=raw, result_set=raw.result_set)
    assert result.columns == ("n.name", "n.urn")


def test_columns_tolerates_a_bare_string_header_entry():
    """Nothing in the codebase constrains every header entry to be a
    ``[type, name]`` pair; a bare name must still come through unchanged."""
    raw = _Res([["Alice"]], header=["n.name"])
    result = CypherResult(raw=raw, result_set=raw.result_set)
    assert result.columns == ("n.name",)


def test_rows_zips_columns_with_each_row():
    raw = _Res([["Alice", "urn:1"], ["Bob", "urn:2"]], header=[[1, "n.name"], [1, "n.urn"]])
    result = CypherResult(raw=raw, result_set=raw.result_set)
    assert result.rows == [
        {"n.name": "Alice", "n.urn": "urn:1"},
        {"n.name": "Bob", "n.urn": "urn:2"},
    ]


# ---------------------------------------------------------------------------
# Read routing: readonly/write x source/projection reach the right chokepoint.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_source_executor_readonly_reaches_ro_query():
    p = _provider()
    calls = []

    async def _ro_query(cypher, params=None, **kw):
        calls.append("ro")
        return _Res([[1]])

    async def _query(cypher, params=None, **kw):
        calls.append("write")
        return _Res([[1]])

    p._ro_query = _ro_query
    p._query = _query

    result = await p.executor.run("RETURN 1", readonly=True)
    assert calls == ["ro"]
    assert result.result_set == [[1]]


@pytest.mark.asyncio
async def test_source_executor_write_reaches_query():
    p = _provider()
    calls = []

    async def _ro_query(cypher, params=None, **kw):
        calls.append("ro")
        return _Res([[1]])

    async def _query(cypher, params=None, **kw):
        calls.append("write")
        return _Res([[1]])

    p._ro_query = _ro_query
    p._query = _query

    result = await p.executor.run("CREATE (n)", readonly=False)
    assert calls == ["write"]
    assert result.result_set == [[1]]


@pytest.mark.asyncio
async def test_projection_executor_readonly_reaches_proj_ro_query():
    p = _provider()
    calls = []

    async def _proj_ro_query(cypher, params=None, **kw):
        calls.append("proj-ro")
        return _Res([[1]])

    async def _proj_query(cypher, params=None, **kw):
        calls.append("proj-write")
        return _Res([[1]])

    p._proj_ro_query = _proj_ro_query
    p._proj_query = _proj_query

    result = await p.projection_executor.run("RETURN 1", readonly=True)
    assert calls == ["proj-ro"]
    assert result.result_set == [[1]]


@pytest.mark.asyncio
async def test_projection_executor_write_reaches_proj_query():
    """Also exercises ``_proj_query``'s additive ``op`` kwarg through the
    executor, which passes it on every call regardless of target."""
    p = _provider()
    calls = []

    async def _proj_ro_query(cypher, params=None, **kw):
        calls.append("proj-ro")
        return _Res([[1]])

    async def _proj_query(cypher, params=None, **kw):
        calls.append(("proj-write", kw))
        return _Res([[1]])

    p._proj_ro_query = _proj_ro_query
    p._proj_query = _proj_query

    result = await p.projection_executor.run("CREATE (n)", readonly=False, op="materialize")
    assert len(calls) == 1
    assert calls[0][0] == "proj-write"
    assert calls[0][1]["op"] == "materialize"
    assert result.result_set == [[1]]


# ---------------------------------------------------------------------------
# run_tolerant routing.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_source_run_tolerant_reaches_ro_query_tolerant():
    p = _provider()
    calls = []

    async def _ro_query_tolerant(cypher, params=None, **kw):
        calls.append("tolerant")
        return _Res([[1]])

    p._ro_query_tolerant = _ro_query_tolerant

    result = await p.executor.run_tolerant("RETURN 1")
    assert calls == ["tolerant"]
    assert result.result_set == [[1]]


@pytest.mark.asyncio
async def test_projection_run_tolerant_masks_a_verified_missing_graph():
    """Mirrors ``_ro_query_tolerant``'s own try/verify/mask shape: the
    projection graph has no native tolerant chokepoint, so the executor
    reproduces it around ``_proj_ro_query`` using
    ``_is_verified_missing_graph``.
    """
    p = _provider()
    boom = RuntimeError("Invalid graph operation on empty key")

    async def _proj_ro_query(cypher, params=None, **kw):
        raise boom

    async def _is_verified_missing_graph(exc):
        assert exc is boom
        return True

    p._proj_ro_query = _proj_ro_query
    p._is_verified_missing_graph = _is_verified_missing_graph

    result = await p.projection_executor.run_tolerant("MATCH (n) RETURN n")
    assert result.result_set == []
    assert result.columns == ()


@pytest.mark.asyncio
async def test_projection_run_tolerant_reraises_when_not_verified_missing():
    p = _provider()
    boom = RuntimeError("some other failure")

    async def _proj_ro_query(cypher, params=None, **kw):
        raise boom

    async def _is_verified_missing_graph(exc):
        return False

    p._proj_ro_query = _proj_ro_query
    p._is_verified_missing_graph = _is_verified_missing_graph

    with pytest.raises(RuntimeError) as excinfo:
        await p.projection_executor.run_tolerant("MATCH (n) RETURN n")
    assert excinfo.value is boom


@pytest.mark.asyncio
async def test_source_and_projection_tolerant_masking_are_pinned_together():
    """The two tests above pin the projection copy of the tolerant-masking
    rule against itself (a fake ``_is_verified_missing_graph`` it also
    controls). That proves the executor calls the predicate, but not that
    its rule agrees with the original: the same rule exists in two places
    -- ``connection.py``'s ``_ro_query_tolerant`` (the original, source
    target) and this module's ``run_tolerant`` projection branch (a
    deliberate duplicate, documented at the top of executor.py) -- and
    only the first is where someone extending the masking rule would look.

    This test drives the SAME exception through BOTH paths using the
    REAL, unpatched ``_is_verified_missing_graph`` (safe here: a freshly
    constructed, never-connected provider has ``_conn_cfg is None``, so
    ``_empty_key_is_genuine`` short-circuits to True and the predicate
    reduces to ``_is_missing_graph_error`` alone). A future change that
    teaches one copy to mask an additional exception class and not the
    other fails here; each path's own tests, pinned only to a fake they
    also control, would not notice.
    """
    async def _outcome(coro):
        """Normalize "masked to an empty result_set" vs. "raised" so a
        divergence in EITHER direction lands on the same assertion message
        below, instead of an unhandled exception from whichever path
        stopped masking (or started masking) -- pytest would still name
        the right line, but not with this test's own explanation attached.
        """
        try:
            result = await coro
            return ("masked", result.result_set)
        except Exception as exc:  # noqa: BLE001 -- deliberately broad, see above
            return ("raised", exc)

    diverged = (
        "the source (connection.py's _ro_query_tolerant) and projection "
        "(executor.py's run_tolerant) copies of the tolerant-masking rule "
        "disagreed on the SAME exception -- update both copies together."
    )

    p_missing = _provider()
    missing_exc = RuntimeError("Invalid graph operation on empty key")

    async def _ro_query_raises_missing(cypher, params=None, **kw):
        raise missing_exc

    async def _proj_ro_query_raises_missing(cypher, params=None, **kw):
        raise missing_exc

    p_missing._ro_query = _ro_query_raises_missing
    p_missing._proj_ro_query = _proj_ro_query_raises_missing

    source_outcome = await _outcome(p_missing._ro_query_tolerant("MATCH (n) RETURN n"))
    projection_outcome = await _outcome(p_missing.projection_executor.run_tolerant("MATCH (n) RETURN n"))

    assert source_outcome == ("masked", []), (diverged, "source", source_outcome)
    assert projection_outcome == ("masked", []), (diverged, "projection", projection_outcome)

    p_other = _provider()
    other_exc = RuntimeError("connection reset by peer")

    async def _ro_query_raises_other(cypher, params=None, **kw):
        raise other_exc

    async def _proj_ro_query_raises_other(cypher, params=None, **kw):
        raise other_exc

    p_other._ro_query = _ro_query_raises_other
    p_other._proj_ro_query = _proj_ro_query_raises_other

    source_outcome = await _outcome(p_other._ro_query_tolerant("MATCH (n) RETURN n"))
    projection_outcome = await _outcome(p_other.projection_executor.run_tolerant("MATCH (n) RETURN n"))

    assert source_outcome == ("raised", other_exc), (diverged, "source", source_outcome)
    assert projection_outcome == ("raised", other_exc), (diverged, "projection", projection_outcome)


# ---------------------------------------------------------------------------
# The interception test -- the point of the whole design.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_spy_assigned_after_touching_the_executor_property_still_intercepts():
    """Ordered specifically to catch a captured reference: touch (and
    cache) the property FIRST, THEN patch the instance method, THEN call.
    If ``FalkorDBExecutor.run`` captured ``owner._ro_query`` at
    ``__init__`` time instead of looking it up on the owner per call, the
    spy below would never run even though ``p._ro_query = spy`` looks
    identical to the 26 other sites in this suite that depend on it.
    """
    p = _provider()

    executor_before_patch = p.executor  # construct (and cache) the executor FIRST

    issued = []

    async def _ro_query_spy(cypher, params=None, **kw):
        issued.append(cypher)
        return _Res([[1]])

    p._ro_query = _ro_query_spy  # patch AFTER the executor already exists

    result = await p.executor.run("RETURN 1")

    assert p.executor is executor_before_patch, "the cached property must not rebuild on every access"
    assert issued == ["RETURN 1"], (
        "FalkorDBExecutor.run did not reach the spy assigned to `p._ro_query` "
        "AFTER the executor was already constructed. This means `run` captured "
        "a bound `_ro_query` reference at construction time instead of looking "
        "it up on the owner at call time -- exactly the regression this test "
        "exists to catch. Every one of the 26 sites elsewhere in this suite "
        "that fake the database via `p._ro_query = <fake>` would silently stop "
        "intercepting and start exercising the real code path (or a real "
        "database) while still reporting green."
    )
    assert result.result_set == [[1]]


# ---------------------------------------------------------------------------
# timeout_s / op passthrough.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_s_and_op_reach_the_chokepoint_unchanged():
    p = _provider()
    captured = {}

    async def _ro_query(cypher, params=None, **kw):
        captured.update(kw)
        return _Res([[1]])

    p._ro_query = _ro_query

    await p.executor.run("RETURN 1", timeout_s=7.5, op="probe")

    assert captured["timeout"] == 7.5, "timeout_s must reach the chokepoint as `timeout=`"
    assert captured["op"] == "probe"


# ---------------------------------------------------------------------------
# A __new__-built instance can still reach .executor.
# ---------------------------------------------------------------------------


def test_new_built_instance_can_still_reach_executor():
    """Three existing tests build a FalkorDBProvider via __new__ without
    running __init__ (test_ensure_indices_onboarding.py:110,
    test_falkordb_ancestors_cache_reset.py:16,
    test_falkordb_pool_resilience.py:218). The executor properties must
    not assume __init__ ran -- they are implemented as
    ``functools.cached_property``, which needs only a real instance
    ``__dict__`` to write its cached value into (present on every
    instance regardless of whether __init__ ran, since neither
    FalkorDBProvider nor any of its mixins define ``__slots__``).
    """
    p = FalkorDBProvider.__new__(FalkorDBProvider)

    executor = p.executor
    assert isinstance(executor, FalkorDBExecutor)
    assert executor.target == "source"
    assert p.executor is executor  # cached, not rebuilt on the next access

    projection = p.projection_executor
    assert isinstance(projection, FalkorDBExecutor)
    assert projection.target == "projection"
    assert projection is not executor


def test_executor_properties_construct_falkordbexecutor_exactly_once(monkeypatch):
    """Identity alone -- ``p.executor is p.executor``, already asserted
    above -- does NOT catch the regression this test is for, and would not
    have caught the original one either. A first version of these
    properties used ``self.__dict__.setdefault("_executor",
    FalkorDBExecutor(self, "source"))``, which also returns the SAME
    cached object on every call (setdefault discards its argument when
    the key already exists), so identity holds either way. What it did
    NOT do is avoid the cost: Python evaluates a call's arguments before
    the call, so that ``FalkorDBExecutor(...)`` argument was constructed
    -- and thrown away -- on every access after the first. The current
    ``functools.cached_property`` implementation makes that cost
    structurally impossible (a non-data descriptor: after the first
    access this getter never runs again), but nothing stops a future edit
    from "simplifying" it back to a hand-rolled cache that reintroduces
    the same waste. Counting constructions directly is the only way to
    pin "exactly once" either way.
    """
    calls = []
    real_init = FalkorDBExecutor.__init__

    def counting_init(self, owner, target):
        calls.append(target)
        real_init(self, owner, target)

    monkeypatch.setattr(FalkorDBExecutor, "__init__", counting_init)

    p = _provider()
    for _ in range(5):
        p.executor
    for _ in range(5):
        p.projection_executor

    assert calls == ["source", "projection"], (
        "FalkorDBExecutor must be constructed exactly once per property "
        f"(source, then projection) across repeated access; got {calls}. "
        "A naive `p.executor is p.executor` identity check would NOT "
        "catch this -- setdefault's cached return value is identical "
        "across calls even though it silently discards a freshly built, "
        "unused FalkorDBExecutor on every call after the first."
    )


# ---------------------------------------------------------------------------
# Not one of the six specified tests above: every test in this file reaches
# _proj_query through a SPY, which would keep passing even if the real
# method's new `op` parameter were misspelled or missing -- no existing call
# site passes `op=`, so nothing else in the suite calls the real signature
# with it either. This calls the actual ConnectionMixin._proj_query,
# unpatched, to prove the additive kwarg is real on the method the executor
# depends on.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proj_query_real_signature_accepts_the_new_op_kwarg():
    p = _provider()

    async def _fake_query(cypher, params=None, timeout=None):
        return _Res([[1]])

    p._graph = types.SimpleNamespace(query=_fake_query)  # _proj resolves to _graph in "in_source" mode

    result = await p._proj_query("RETURN 1", op="probe")
    assert result.result_set == [[1]]
