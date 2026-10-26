"""LIVE: no compiled shape that slices text can crash FalkorDB — needs a real FalkorDB.

FalkorDB 4.18's ``substring`` reads beyond the end of a multi-byte string asked to start at or past
its last character but short of its last byte ("Zoë1" from 4 on: four characters, five bytes) — a
string a substring made too, at its end — and the read can take the whole server down: every
user's queries fail until it restarts. It hangs on whatever lies past the string, so it comes and
goes; a date filter over twenty thousand such values found it at once. Every compiled shape that
slices text therefore runs here over thousands of stored values that meet that condition for every
start the shapes slice at, in a WHERE and in a projection, where every branch runs, and the server
must still answer after each.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_crash_guard_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest

from backend.app.providers.falkordb_placement import glob_test, layer_test
from backend.app.providers.falkordb_search.relevance import _Builder
from backend.app.providers.falkordb_typed_ops import compile_comparison, compile_key_comparison
from backend.app.services.view_placement import LayerTarget, PlacementSpec
from backend.common.search_semantics import resolve_comparison, resolve_key_comparison


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live crash guard.",
)

#: Runs of each statement, every one over every risky value.
ROUNDS = 5

#: Up to twelve characters with one to three multi-byte ones among them, so a start from 1 to 12
#: falls between the last character and the last byte of many; and dates, near-dates and lists.
TEXTS = sorted({
    *(f"{lead}{i}"[:n] for lead in ("Zoë", "é", "😀", "日本", "aé😀b", "ééé") for i in range(400)
      for n in (4, 5, 7, 8, 9, 12)),
    "", "a", "2024-05-0", "2024-05-01", "2024-05-01T10:00:00", "2024-05-01 23:59:59",
    "20é4-05-01", "éééé-éé-éé", "2024-05-é", "2024-é5-01",
})
VALUES = TEXTS + [["é😀", "Zoë1"], [""], ["2024-05-01", "日本語"]]


@pytest.fixture(scope="module")
def graph():
    from falkordb import FalkorDB

    db = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                  port=int(os.getenv("FALKORDB_PORT", "6379")))
    g = db.select_graph(f"guard_{uuid.uuid4().hex[:8]}")
    rows = [{"i": i, "v": v, "w": VALUES[(i + 3) % len(VALUES)]} for i, v in enumerate(VALUES)]
    g.query("UNWIND $rows AS r CREATE (n:T {i: r.i}) SET n.v = r.v, n.w = r.w", {"rows": rows})
    g.query("UNWIND $urns AS u CREATE (:Domain {urn: u, tags: '[]'})", {"urns": TEXTS[1:]})
    g.query("MATCH (p:Domain {urn: 'Zoë1'}), (c:Domain) WHERE c.urn STARTS WITH 'Zoë2' "
            "CREATE (p)-[:CONTAINS]->(c)")
    try:
        yield g
    finally:
        g.delete()


class _Params:
    def __init__(self):
        self.params = {}

    def bind(self, value):
        name = f"p{len(self.params)}"
        self.params[name] = value
        return f"${name}"


def _hammer(g, cypher, params):
    """Run a statement ``ROUNDS`` times, then make sure the server still answers."""
    for _ in range(ROUNDS):
        g.query(cypher, params)
    assert g.query("RETURN 1").result_set == [[1]], "FalkorDB stopped answering"


DATE_COMPARISONS = [
    ("eq", "2024-05-01"), ("gt", "2024-05-01T10:00:00"), ("lt", "2024-05-01"),
    ("between", ["2024-01-01", "2024-12-31"]), ("withinLast", "P30D"), ("withinLast", "PT12H"),
]


@pytest.mark.parametrize("op,value", DATE_COMPARISONS, ids=[f"{o}-{v}" for o, v in DATE_COMPARISONS])
def test_date_comparisons_never_crash(graph, op, value):
    p = _Params()
    test = compile_comparison("n.v", resolve_comparison(op, value), p.bind)
    _hammer(graph, f"MATCH (n:T) WHERE {test} RETURN n.i", p.params)
    _hammer(graph, f"MATCH (n:T) RETURN n.i, {test}", p.params)


@pytest.mark.parametrize("op", ["eq", "lt", "gte"])
def test_date_key_comparisons_never_crash(graph, op):
    test = compile_key_comparison("n.v", "n.w", resolve_key_comparison(op, value_type="date"))
    _hammer(graph, f"MATCH (n:T) WHERE {test} RETURN n.i", {})
    _hammer(graph, f"MATCH (n:T) RETURN n.i, {test}", {})


GLOBS = ["*é", "é*", "?é*", "*😀?", "*?*", "a*é*b", "u?:*", "*-?é-*", "??????????", "日*本"]


@pytest.mark.parametrize("pattern", GLOBS)
def test_globs_never_crash(graph, pattern):
    """A glob reads text or null — the layer filter hands it ``toStringOrNull`` of the URN."""
    p = _Params()
    test = glob_test("toStringOrNull(n.v)", pattern, p.bind, "g")
    _hammer(graph, f"MATCH (n:T) WHERE {test} RETURN n.i", p.params)
    _hammer(graph, f"MATCH (n:T) RETURN n.i, coalesce({test}, false)", p.params)


def test_the_layer_filter_never_crashes(graph):
    """Rules on the URN glob and on a property comparison, read for an entity and its
    ancestors."""
    spec = PlacementSpec.from_config({"layout": {"referenceLayout": {"layers": [
        {"id": "a", "name": "A", "order": 0, "rules": [
            {"id": "g", "priority": 3, "urnPattern": "u?:*é*"},
            {"id": "c", "priority": 2, "conditions": [
                {"field": "name", "operator": "startsWith", "value": "日"}]},
            {"id": "d", "priority": 1, "conditions": [
                {"field": "urn", "operator": "endsWith", "value": "😀"}]}]},
        {"id": "b", "name": "B", "order": 1, "entityTypes": ["Domain"]},
    ], "assignments": {"Zoë3": {"layerId": "b", "inheritsChildren": True}}}}})
    for layer_id in ("a", "b"):
        p = _Params()
        test = layer_test(LayerTarget(spec, layer_id, "d"), "n", name=lambda: "1", bind=p.bind,
                          containment=["CONTAINS"])
        _hammer(graph, f"MATCH (n:Domain) WITH n, {test} AS t WHERE t RETURN n.urn", p.params)


@pytest.mark.parametrize("needle", ["é", "a", "😀", "本"])
def test_word_relevance_never_crashes(graph, needle):
    b = _Builder()
    word = b._word("toLower(toStringOrNull(n.v))", b.bind(needle))
    _hammer(graph, f"MATCH (n:T) RETURN n.i, {word}", b.params)
