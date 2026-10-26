"""The parse-cost estimate held to FalkorDB's own times.

``native_query.parse_cost`` replays libcypher-parser's rule — an operand with
no operator after it is parsed twice — to refuse statements FalkorDB would
take too long just to parse, and the compilers write nested conditions so the
time stays linear. Here, against the real engine: the time to EXPLAIN a
statement (parse and plan, on a graph too small to plan for long) follows the
estimate across every kind of nesting, at one rate; and what the estimate
calls linear parses as fast at fourteen levels as at four.
"""
from __future__ import annotations

import os
import time
import uuid

import pytest

from backend.app.services.native_query.parse_cost import parse_cost

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to time FalkorDB's parser.",
)

LEAF = "x.owner = $p0"


def nest(wrap, depth: int) -> str:
    leaf = LEAF
    for i in range(depth):
        leaf = wrap(leaf, i)
    return f"MATCH (x) RETURN {leaf}"


#: Each doubles or quadruples the time per level; deep enough to time well,
#: none past a third of a second.
EXPONENTIAL = [
    *(nest(lambda e, i: f"NOT ({e})", d) for d in (6, 7, 8)),
    *(nest(lambda e, i: f"coalesce({e}, false)", d) for d in (11, 12, 13)),
    *(nest(lambda e, i: f"CASE WHEN {e} THEN true END", d) for d in (11, 12, 13)),
    *(nest(lambda e, i: f"ANY(_z{i} IN [1] WHERE {e})", d) for d in (10, 11, 12)),
    *(nest(lambda e, i: f"({e})", d) for d in (11, 12, 13)),
]
#: An operator after each level: linear.
LINEAR = [
    nest(lambda e, i: f"({e}) = false", 14),
    nest(lambda e, i: f"ANY(_z{i} IN [1] WHERE {e}) = true", 14),
    nest(lambda e, i: f"coalesce({e} = true, false) = true", 14),
]


@pytest.fixture(scope="module")
def graph():
    from falkordb import FalkorDB

    g = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                 port=int(os.getenv("FALKORDB_PORT", "6379")),
                 socket_timeout=120).select_graph(f"parse_cost_{uuid.uuid4().hex[:8]}")
    g.query("CREATE (:A {owner: 'x'})")
    try:
        yield g
    finally:
        g.delete()


def parse_ms(graph, cypher: str) -> float:
    """The fastest of three EXPLAINs, each of a new text: FalkorDB caches a
    plan by its text, and a cached one is never parsed again."""
    best = None
    for _ in range(3):
        fresh = cypher.replace("RETURN ", f"RETURN 1 AS u{uuid.uuid4().hex[:8]}, ", 1)
        start = time.perf_counter()
        graph.explain(fresh, {"p0": "x"})
        ms = (time.perf_counter() - start) * 1000
        best = ms if best is None else min(best, ms)
    return best


def test_the_estimate_follows_falkordbs_time_across_every_kind_of_nesting(graph):
    rates = [parse_ms(graph, q) / parse_cost(q) for q in EXPONENTIAL]
    assert max(rates) / min(rates) < 6, rates


def test_what_the_estimate_calls_linear_parses_fast_however_deep(graph):
    for q in LINEAR:
        assert parse_cost(q) < 300
        assert parse_ms(graph, q) < 50
