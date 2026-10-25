"""LIVE FalkorDB parity for comparing one property with another of the
same entity (``value_key``) — needs a real FalkorDB (no Postgres).

``search_semantics.evaluate_keys`` is the meaning, and
``falkordb_typed_ops.compile_key_comparison`` claims to compile exactly it.
One node holds each PAIR of awkward stored values (int64 extremes that
wrap FalkorDB's integer order, numeric and decimal text, floats, booleans,
dates, lists, a missing key), and for every comparison FalkorDB's ids must
be the evaluator's — in a WHERE and in a projection, where every branch
runs.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_key_comparison_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest

from backend.app.providers.falkordb_typed_ops import compile_key_comparison
from backend.common.search_semantics import evaluate_keys, resolve_key_comparison


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live parity test.",
)

VALUES = [
    None, "", 15, "15", 7, "7", 1.5, "1.5", 15.0, -1, 0,
    2 ** 63 - 1, -(2 ** 63), "-3746471915534727923", "0.1",
    "abc", "Alpha", "alpha", True, "true",
    "2024-05-01", "2024-05-01T10:00:00", "2024-05-01 23:59:59",
    [1, 2], ["alpha", "15"], [],
]
PAIRS = [(a, b) for a in VALUES for b in VALUES]

COMPARISONS = [
    # op, value_type, case_sensitive
    *[(op, t, False) for op in ("eq", "neq", "gt", "gte", "lt", "lte")
      for t in ("auto", "number", "string", "date")],
    ("eq", "string", True),
    ("neq", "string", True),
    ("eq", "boolean", False),
    ("neq", "boolean", False),
]
IDS = [f"{op}-{t}-cs{int(cs)}" for op, t, cs in COMPARISONS]


@pytest.fixture(scope="module")
def graph():
    from falkordb import FalkorDB

    db = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                  port=int(os.getenv("FALKORDB_PORT", "6379")))
    g = db.select_graph(f"keys_{uuid.uuid4().hex[:8]}")
    rows = [{"id": i, "a": a, "b": b} for i, (a, b) in enumerate(PAIRS)]
    # SET n.a = null leaves the key missing, which is what None means.
    g.query("UNWIND $rows AS r CREATE (n:T {id: r.id}) SET n.a = r.a, n.b = r.b", {"rows": rows})
    try:
        yield g
    finally:
        g.delete()


def test_pairs_round_trip(graph):
    """The evaluator reads exactly what FalkorDB stored."""
    got = {r[0]: (r[1], r[2]) for r in graph.query("MATCH (n:T) RETURN n.id, n.a, n.b").result_set}
    assert [got[i] for i in range(len(PAIRS))] == PAIRS


@pytest.mark.parametrize("op,value_type,case_sensitive", COMPARISONS, ids=IDS)
def test_compiled_cypher_matches_the_evaluator(graph, op, value_type, case_sensitive):
    cmp = resolve_key_comparison(op, value_type=value_type, case_sensitive=case_sensitive)
    where = compile_key_comparison("n.a", "n.b", cmp)
    got = sorted(r[0] for r in graph.query(f"MATCH (n:T) WHERE {where} RETURN n.id").result_set)
    want = sorted(i for i, (a, b) in enumerate(PAIRS) if evaluate_keys(a, b, cmp))
    assert got == want, {
        "cypher_only": [PAIRS[i] for i in set(got) - set(want)],
        "python_only": [PAIRS[i] for i in set(want) - set(got)],
    }


@pytest.mark.parametrize("op,value_type,case_sensitive", COMPARISONS, ids=IDS)
def test_a_projection_evaluates_every_branch_safely(graph, op, value_type, case_sensitive):
    """Rule membership and counts project the fragment: no stored kind may
    raise there, and the answer must be the WHERE's."""
    cmp = resolve_key_comparison(op, value_type=value_type, case_sensitive=case_sensitive)
    fragment = compile_key_comparison("n.a", "n.b", cmp)
    projected = {r[0] for r in graph.query(
        f"MATCH (n:T) RETURN n.id, ({fragment}) AS m").result_set if r[1] is True}
    filtered = {r[0] for r in graph.query(f"MATCH (n:T) WHERE {fragment} RETURN n.id").result_set}
    assert projected == filtered
