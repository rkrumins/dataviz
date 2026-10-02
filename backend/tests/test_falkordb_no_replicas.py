"""A master refusing writes for want of replicas is flow control, not an outage.

``-NOREPLICAS Not enough good replicas to write`` is what a node configured
with ``min-replicas-to-write`` answers while a replica is behind or gone. It
keeps serving READS perfectly throughout — the guard is only ever about
writes — and it clears itself the moment the replica is back in sync.

On the shapes this deployment targets that is an hour: a big node replaying
an RDB is exactly "a replica that is behind", for as long as the replay takes.
Operators reported seeing the raw error during precisely that window.

Nothing classified it. It reached the breaker as an unclassified
``ResponseError``, so three refused writes opened the breaker for its whole
reset window — and a condition that only ever blocked WRITES started refusing
every READ of that graph too, which is the opposite of what the store was
doing. Now it is a logical ``ProviderBusy``: the breaker ignores it, the
worker parks without spending a retry, and the wait is long enough to be
worth taking.

No live FalkorDB required — the guarded call is a stub that raises it.
"""
import asyncio
import os

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError, ResponseError

from backend.app.providers import falkordb_provider as fp
from backend.app.providers.falkordb_provider import (
    FalkorDBProvider, _is_no_replicas_error,
)
from backend.common.adapters import ProviderBusy, ProviderUnavailable
from backend.common.adapters.circuit import _DEFAULT_IGNORED_EXCEPTIONS


_NOREPL = ResponseError("NOREPLICAS Not enough good replicas to write.")


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    return p


# ── _is_no_replicas_error ────────────────────────────────────────────


def test_it_matches_the_error_redis_actually_sends():
    assert _is_no_replicas_error(_NOREPL)


def test_it_matches_the_code_and_the_prose_independently():
    """The ``-NOREPLICAS`` code is stable across versions; the sentence after
    it is not. Either alone is enough."""
    assert _is_no_replicas_error(ResponseError("NOREPLICAS"))
    assert _is_no_replicas_error(Exception("Not enough good replicas to write"))


def test_it_walks_the_cause_chain():
    outer = RuntimeError("write batch failed")
    outer.__cause__ = _NOREPL
    assert _is_no_replicas_error(outer)


def test_it_rejects_the_neighbours_it_would_be_confused_with():
    assert not _is_no_replicas_error(RedisConnectionError("Connection reset by peer"))
    assert not _is_no_replicas_error(Exception("READONLY You can't write against a read only replica"))
    assert not _is_no_replicas_error(Exception("LOADING Redis is loading the dataset in memory"))
    assert not _is_no_replicas_error(Exception("syntax error near MATCH"))


# ── breaker classification ───────────────────────────────────────────


def test_the_breaker_ignores_it():
    """THE REGRESSION. Counted as a failure, three refused writes open the
    breaker — and then the reads that were still working stop too."""
    assert ProviderBusy in _DEFAULT_IGNORED_EXCEPTIONS


def test_it_still_maps_to_a_retryable_http_answer():
    assert issubclass(ProviderBusy, ProviderUnavailable)


# ── _run_guarded integration ─────────────────────────────────────────


def test_a_refused_write_becomes_provider_busy_naming_the_node():
    p = _make_provider()

    async def _refused():
        raise _NOREPL

    async def _run():
        with pytest.raises(ProviderBusy) as exc_info:
            await p._run_guarded(_refused)
        reason = exc_info.value.reason
        # The operator needs the node and the reason, not the raw code.
        assert "in-sync replicas" in reason
        assert "min-replicas-to-write" in reason
        # ...and that their reads are fine, because the instinct on seeing
        # this is to declare the store down.
        assert "reads are unaffected" in reason

    asyncio.run(_run())


def test_it_does_not_burn_the_transient_retry_budget():
    """Deterministic for as long as the condition holds, and the condition
    lasts as long as a reload. Retrying inside one operation's budget spends
    it for nothing and lands on the same refusal."""
    p = _make_provider()
    calls = {"n": 0}

    async def _refused():
        calls["n"] += 1
        raise _NOREPL

    async def _run():
        with pytest.raises(ProviderBusy):
            await p._run_guarded(_refused)

    asyncio.run(_run())
    assert calls["n"] == 1, f"retried a deterministic refusal {calls['n']} times"


def test_the_wait_is_long_enough_to_be_worth_taking():
    """A client told to come back in 3 s against an hour-long reload spends
    its whole budget before a replica could possibly have loaded."""
    assert fp._NOREPLICAS_RETRY_AFTER_S >= 60


def test_the_park_budget_and_the_wait_together_cover_a_reload():
    """The pair is the contract, not either number alone: the worker parks on
    ProviderBusy without consuming a retry, up to
    AGGREGATION_MAX_QUIESCE_EVENTS times, waiting retry_after_seconds each
    time. That product is what a rebuild has to sit through to survive one
    node reload — raise either bound and the pair must still cover it."""
    parks = int(os.getenv("AGGREGATION_MAX_QUIESCE_EVENTS", "20"))
    assert parks * fp._NOREPLICAS_RETRY_AFTER_S >= 3600, (
        f"{parks} parks x {fp._NOREPLICAS_RETRY_AFTER_S}s does not cover the "
        "hour-long node reload this was sized for"
    )


def test_reads_are_never_turned_into_this():
    """The guard is write-only at the store, and must stay write-only here:
    a read that fails for an unrelated reason must not be relabelled."""
    p = _make_provider()

    async def _broken_read():
        raise ResponseError("Invalid input 'X': expected an identifier")

    async def _run():
        with pytest.raises(ResponseError):
            await p._run_guarded(_broken_read, read_only=True)

    asyncio.run(_run())


# ── the pipeline must not mistake it for the store being down ────────


def test_it_is_not_store_pressure():
    """``_pressure_kind`` drives the rebuild's three reactions: ask for less
    (memory/timeout) or wait for the node (connection). This is none of them.

    ``ProviderLoading`` and ``ProviderFailingOver`` ARE classified
    "connection" — the node is not answering yet and the run should wait in
    place. This one is the opposite: the node is answering, and answering
    reads correctly. Routing it through the outage hold would log "the graph
    store node is not answering" about a node that plainly is, and hold the
    graph lease for an hour on a diagnosis that is wrong.

    Propagating is what puts it in the worker's park loop instead, which is
    the mechanism built for "healthy but refusing" — park, do not spend a
    retry, come back.
    """
    from backend.app.providers.falkordb_provider import _pressure_kind
    from backend.common.adapters import ProviderFailingOver, ProviderLoading

    busy = ProviderBusy(provider_name="g", reason="too few in-sync replicas")
    assert _pressure_kind(busy) is None

    # The neighbours it must stay distinct from.
    assert _pressure_kind(ProviderLoading("g", "loading")) == "connection"
    assert _pressure_kind(ProviderFailingOver("g", "failing over")) == "connection"


def test_the_rebuild_ladder_lets_it_through():
    """The write ladder halves a batch for memory or timeout pressure and
    re-raises everything else. Halving would not help here — every half is
    refused for the same reason — so it must reach the worker whole."""
    from backend.app.providers import falkordb_materialize as mat

    busy = ProviderBusy(provider_name="g", reason="too few in-sync replicas")
    assert mat._pressure_kind(busy) is None
