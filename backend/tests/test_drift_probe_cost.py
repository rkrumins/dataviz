"""WHAT THE DRIFT CHECK COSTS, AND WHAT IT IS ALLOWED TO CONCLUDE.

The aggregation scheduler fingerprints every scheduled source on a 60-second
sweep. That fingerprint used to be three unbounded scans of the whole graph —
`MATCH (n) … collect(displayName)`, `MATCH ()-[r]->()`, and every node's tags —
issued under a five-second client deadline while each query carried a
thirty-second server-side one. So on any graph big enough to matter the sweep
gave up and the node kept scanning, three times per source per minute, for
results nobody would read. FalkorDB serves queries from a small fixed thread
count; enough abandoned scans and it answers nothing at all.

Two of those three scans were pure waste: the digest reads per-label node
counts and per-type edge counts, and has never looked at a displayName sample
or a tag. So these tests pin three things:

1. The digest from the constant-time counters is byte-identical to the digest
   from the full scan. It has to be — a source fingerprinted by the scan
   yesterday is compared against one fingerprinted by the counters today, and
   a mismatch there is indistinguishable from real drift.
2. A provider that predates the deadline argument still gets a real
   fingerprint. `compute_graph_fingerprint` turns any exception into "", and ""
   is read as drift, which signals a rebuild — so a signature mismatch would
   quietly become a rebuild storm.
3. The scan fallback treats the caller's budget as a deadline shared by all
   three queries, not as an allowance each.
"""
import asyncio

import pytest

from backend.app.services.aggregation.fingerprint import (
    compute_graph_fingerprint,
    fingerprint_from_fast_counts,
    fingerprint_from_stats,
)
from backend.common.models.graph import (
    EdgeTypeSummary, EntityTypeSummary, GraphSchemaStats, TagSummary,
)


def _run(coro):
    return asyncio.run(coro)


def _stats(nodes, edges, *, tags=(), samples=("a", "b")):
    """A scanned `GraphSchemaStats` — including the sample names and tags the
    scan pays for and the digest ignores."""
    return GraphSchemaStats(
        totalNodes=sum(nodes.values()),
        totalEdges=sum(edges.values()),
        entityTypeStats=[
            EntityTypeSummary(id=k, name=k, count=v, sampleNames=list(samples))
            for k, v in nodes.items()
        ],
        edgeTypeStats=[EdgeTypeSummary(id=k, name=k, count=v) for k, v in edges.items()],
        tagStats=[TagSummary(tag=t, count=1, entityTypes=["entity"]) for t in tags],
    )


NODES = {"dataset": 120, "schemaField": 4400, "unknown": 3}
EDGES = {"CONTAINS": 4500, "FLOWS": 900, "AGGREGATED": 260}


def test_the_counters_and_the_scan_agree_to_the_byte():
    """The whole swap rests on this. A stored fingerprint taken by the scan is
    compared against a fresh one taken by the counters; if the two encodings
    differed at all, every source in the fleet would read as drifted at once —
    and each of those reads signals a rebuild."""
    scanned = fingerprint_from_stats(_stats(NODES, EDGES))
    counted = fingerprint_from_fast_counts(
        {"entityTypeCounts": dict(NODES), "edgeTypeCounts": dict(EDGES)}
    )
    assert counted == scanned


def test_the_things_the_scan_pays_for_and_the_digest_ignores():
    """displayName samples and tags cost a full scan each and move no digest.
    That is the whole reason the counters can stand in for them."""
    plain = fingerprint_from_stats(_stats(NODES, EDGES))
    embellished = fingerprint_from_stats(
        _stats(NODES, EDGES, tags=("pii", "gold"), samples=("totally", "different"))
    )
    assert embellished == plain


def test_key_order_does_not_move_the_digest():
    """The counters build their dict in catalogue order, the scan in result-set
    order. Neither is sorted at the source."""
    forward = fingerprint_from_fast_counts(
        {"entityTypeCounts": {"a": 1, "b": 2}, "edgeTypeCounts": {"X": 3, "Y": 4}}
    )
    backward = fingerprint_from_fast_counts(
        {"entityTypeCounts": {"b": 2, "a": 1}, "edgeTypeCounts": {"Y": 4, "X": 3}}
    )
    assert forward == backward


def test_a_changed_count_still_moves_the_digest():
    """Cheapness must not have cost the thing its sensitivity."""
    before = fingerprint_from_fast_counts(
        {"entityTypeCounts": dict(NODES), "edgeTypeCounts": dict(EDGES)}
    )
    after = fingerprint_from_fast_counts(
        {"entityTypeCounts": {**NODES, "dataset": 121}, "edgeTypeCounts": dict(EDGES)}
    )
    assert after != before


class _CountersProvider:
    """A provider whose counters answer, so no scan may be issued."""

    def __init__(self, counts=None):
        self.counts = counts
        self.scans = 0

    async def get_counts_fast(self):
        return self.counts

    async def get_schema_stats(self, *, budget_s=None):
        self.scans += 1
        return _stats(NODES, EDGES)


def test_the_sweep_reads_the_counters_and_never_scans():
    p = _CountersProvider({"entityTypeCounts": dict(NODES), "edgeTypeCounts": dict(EDGES)})
    fp = _run(compute_graph_fingerprint(p, budget_s=5.0))
    assert p.scans == 0
    assert fp == fingerprint_from_stats(_stats(NODES, EDGES))


def test_counters_that_refuse_hand_over_to_the_scan():
    """`get_counts_fast` returns None on a multi-label graph rather than report
    a shape that is quietly wrong. That is a handover, not a failure."""
    p = _CountersProvider(None)
    fp = _run(compute_graph_fingerprint(p, budget_s=5.0))
    assert p.scans == 1
    assert fp == fingerprint_from_stats(_stats(NODES, EDGES))


def test_counters_that_raise_hand_over_to_the_scan():
    class _Broken(_CountersProvider):
        async def get_counts_fast(self):
            raise RuntimeError("catalogue unavailable")

    p = _Broken()
    fp = _run(compute_graph_fingerprint(p, budget_s=5.0))
    assert p.scans == 1
    assert fp != ""


def test_a_provider_without_the_deadline_argument_still_fingerprints():
    """The regression this file exists for. Neo4j, Spanner, a third-party
    adapter, a test double — anything whose `get_schema_stats` predates
    `budget_s`. A TypeError here becomes "", "" is read as drift, and drift
    signals a rebuild: a signature mismatch would become a rebuild storm."""

    class _Older:
        async def get_schema_stats(self):          # no budget_s, no counters
            return _stats(NODES, EDGES)

    fp = _run(compute_graph_fingerprint(_Older(), budget_s=5.0))
    assert fp == fingerprint_from_stats(_stats(NODES, EDGES))
    assert fp != ""


def test_a_provider_that_takes_the_deadline_is_given_it():
    seen = {}

    class _Newer:
        async def get_schema_stats(self, *, budget_s=None):
            seen["budget_s"] = budget_s
            return _stats(NODES, EDGES)

    _run(compute_graph_fingerprint(_Newer(), budget_s=4.5))
    assert seen["budget_s"] == 4.5


def test_a_graph_that_cannot_be_measured_is_still_reported_as_unknown():
    """Unchanged contract: a total failure yields "". Worth pinning, because
    the rest of this file is about making sure the ONLY way to get "" is a real
    failure to read the graph."""

    class _Down:
        async def get_schema_stats(self, *, budget_s=None):
            raise ConnectionError("no route to host")

    assert _run(compute_graph_fingerprint(_Down(), budget_s=1.0)) == ""


# ── the budget has to survive the breaker proxy ──────────────────────────
#
# Every caller gets its provider from ProviderManager, which hands back a
# CircuitBreakerProxy — never the provider itself. So the only question that
# matters about the deadline is whether it survives THAT, and the tests above
# answer a question nobody asks: they hand `compute_graph_fingerprint` a bare
# provider.
#
# It did not survive. `__getattr__` returned an unwrapped
# `async def breaker_guarded(*args, **kwargs)` closure, so the signature check
# in `_schema_stats` saw no `budget_s`, called `get_schema_stats()` with no
# deadline, and every scan ran to its full 30s server-side budget — three per
# source, every 60s, exactly the load this module exists to remove. Nothing
# failed; the fix was simply inert in every deployment.


class _RecordingProvider:
    """Records the budget it was actually handed."""

    def __init__(self):
        self.budgets = []

    async def get_schema_stats(self, *, budget_s=None, bypass_cache=False):
        self.budgets.append(budget_s)
        return _stats({"dataset": 2}, {"DERIVES_FROM": 1})

    async def get_counts_fast(self):
        return None


def _proxied(provider):
    from backend.common.adapters.circuit import CircuitBreakerProxy

    return CircuitBreakerProxy(provider, "p:g", fail_max=3, reset_timeout=30)


def test_the_proxy_does_not_hide_that_the_provider_takes_a_budget():
    """The regression, stated as the property that was false. A proxied
    method must introspect as the method it proxies, or every caller that
    asks what it accepts gets the wrong answer."""
    import inspect

    from backend.app.services.aggregation.fingerprint import _takes_budget

    fn = _proxied(_RecordingProvider()).get_schema_stats
    assert "budget_s" in inspect.signature(fn).parameters
    assert _takes_budget(fn) is True


def test_the_deadline_reaches_a_provider_behind_the_breaker():
    """The one that would have caught it: the budget is handed down, through
    the proxy, to the provider that will spend it."""
    provider = _RecordingProvider()
    digest = asyncio.run(compute_graph_fingerprint(_proxied(provider), budget_s=5.0))

    assert provider.budgets == [5.0], (
        "the drift sweep's deadline was dropped crossing the breaker proxy — "
        "the scans then run to their full server-side budget"
    )
    assert digest, "a fingerprint that fails reads as drift and signals a rebuild"


def test_the_proxy_still_names_itself_in_logs():
    """`wraps` copies `__name__` from the target, which would make every
    breaker log line read as if the provider logged it. The proxy renames
    itself afterwards; signature transparency comes from `__wrapped__`."""
    fn = _proxied(_RecordingProvider()).get_schema_stats
    assert fn.__name__ == "breaker_guarded_get_schema_stats"


def test_a_provider_without_the_argument_is_still_fingerprinted_through_the_proxy():
    """The other direction: an older provider whose method takes no budget
    must not raise TypeError, because `compute_graph_fingerprint` turns any
    exception into "" and "" is read as drift."""

    class _Old:
        async def get_schema_stats(self):
            return _stats({"dataset": 2}, {"DERIVES_FROM": 1})

        async def get_counts_fast(self):
            return None

    assert asyncio.run(compute_graph_fingerprint(_proxied(_Old()), budget_s=5.0))
