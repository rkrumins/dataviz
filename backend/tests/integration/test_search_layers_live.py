"""LIVE FalkorDB parity for the layer filter: a view's layers as its canvas places them — needs
a real FalkorDB (no Postgres).

``view_placement.place_all`` is the reference, and ``falkordb_placement.layer_test`` claims to
compile it. Every case of the shared placement corpus (``tests/fixtures/placement``) is seeded on
its own, and for every layer of its view FalkorDB must find exactly the entities ``place_all``
puts there: at the top of a query, negated (so never null), and as the far end of a
relationship, inside another comprehension. Nodes are written as the provider writes them (a
user property never takes a platform field's name) and read back through its own read path
(``_node_from_props``), so the reference starts from the facts the canvas would load.
Containment is stored parent to child, the way the search walks it, so each case's edges are
turned the way its ontology says. A search knows nothing of a draft's created-in-branch stamps,
so the reference is asked without them.

URN globs are held to ``view_placement._glob`` on their own, over awkward URNs and patterns.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_layers_live.py -q
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest

from backend.app.providers.falkordb_placement import glob_test, layer_test
from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS, _node_from_props
from backend.app.services.view_placement import (
    LayerTarget,
    PlacementSpec,
    _glob,
    child_is_source,
    facts_from_graph_node,
    place_all,
)


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live parity test.",
)

_CORPUS = Path(__file__).resolve().parents[1] / "fixtures" / "placement"
CASES = [case for path in sorted(_CORPUS.glob("*.json"))
         for case in json.loads(path.read_text(encoding="utf-8"))["cases"]]

#: ``place_all`` ignores the edges of a containment cycle; the walk follows them.
CYCLES = {
    "containment-cycle-edges-ignored",
    "cycle-edge-from-a-hand-placed-node-is-ignored",
    "three-node-cycle-with-an-outside-parent",
    "same-pair-two-directions-forms-a-cycle",
}


@pytest.fixture(scope="module")
def graph():
    from falkordb import FalkorDB

    db = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                  port=int(os.getenv("FALKORDB_PORT", "6379")))
    g = db.select_graph(f"layers_{uuid.uuid4().hex[:8]}")
    g.query("CREATE (:Probe {target: 'none'})")      # the graph exists before the first DELETE
    try:
        yield g
    finally:
        g.delete()


class _Params:
    def __init__(self):
        self.params = {}
        self.n = 0

    def bind(self, value):
        name = f"p{len(self.params)}"
        self.params[name] = value
        return f"${name}"

    def name(self):
        self.n += 1
        return str(self.n)


# ---------------------------------------------------------------------------
# Globs
# ---------------------------------------------------------------------------

URNS = [
    "", "a", "b", "ab", "ba", "abc", "abcb", "aab", "abab", "a.raw.b", "x.raw.", ".raw.",
    "urn:li:dataset:(hive,db.t,PROD)", "urn:li:dataset:(hive,db.t,DEV)", "urn:li:chart:(x,1)",
    "é😀", "aé😀b", "a\nb", "a*b", "a?b", "AB", "abcabc",
]
GLOBS = [
    "*", "**", "a*", "*b", "a*b", "*a*", "a?", "?b", "a?b", "??", "???", "a*?", "?*b",
    "*?*", "a**b", "*.raw.*", "*.raw.", "urn:li:dataset:*", "urn:li:dataset:(*,PROD)",
    "urn:li:*:(*,*)", "a*b*c", "a*c*b", "ab*ab", "a?*?b", "*b?b*", "é*", "*😀?", "a*\nb",
    "a", "abc", "AB", "*a*b*c*", "?*?*?",
]


def test_globs_match_view_placement(graph):
    """Every glob, compiled, finds exactly the URNs ``_glob`` fully matches — in a WHERE and in
    a projection, where every branch runs."""
    graph.query("MATCH (n) DETACH DELETE n")
    graph.query("UNWIND $urns AS u CREATE (:U {urn: u})", {"urns": URNS})
    for pattern in GLOBS:
        p = _Params()
        test = glob_test("n.urn", pattern, p.bind, "g")
        want = sorted(u for u in URNS if _glob(pattern).fullmatch(u))
        got = sorted(r[0] for r in graph.query(
            f"MATCH (n:U) WHERE {test} RETURN n.urn", p.params).result_set)
        assert got == want, pattern
        projected = sorted(r[0] for r in graph.query(
            f"MATCH (n:U) WITH n, coalesce({test}, false) AS t WHERE t RETURN n.urn",
            p.params).result_set)
        assert projected == want, pattern


# ---------------------------------------------------------------------------
# The placement corpus
# ---------------------------------------------------------------------------

def _containment(case):
    return {t.upper(): child_is_source(t, d)
            for t, d in case.get("ontology", {}).get("containment", {}).items()}


def _parent_child(case):
    """Each containment edge as ``(parent, child, TYPE)``, the way the graph stores it."""
    containment = _containment(case)
    out = []
    for e in case.get("edges", []):
        is_source = containment.get(e["edgeType"].upper())
        if is_source is None:
            continue
        child, parent = (e["source"], e["target"]) if is_source else (e["target"], e["source"])
        out.append((parent, child, e["edgeType"].upper()))
    return out


def _seed(g, case):
    g.query("MATCH (n) DETACH DELETE n")
    for node in case["nodes"]:
        label = node.get("entityType")
        props = {
            "urn": node["urn"],
            "displayName": node.get("displayName", node["urn"]),
            "tags": json.dumps(node.get("tags", [])),
            **({"layerAssignment": node["layerAssignment"]} if "layerAssignment" in node else {}),
            **({} if label else {"entityType": ""}),
        }
        user = {k: v for k, v in (node.get("properties") or {}).items()
                if v is not None and k not in _RESERVED_NODE_KEYS}
        g.query(f"CREATE (n{':`' + label + '`' if label else ''}) SET n = $props SET n += $user "
                f"CREATE (:Probe {{target: $props.urn}})-[:PROBES]->(n)",
                {"props": props, "user": user})
    for parent, child, edge_type in _parent_child(case):
        g.query(f"MATCH (a {{urn: $p}}), (b {{urn: $c}}) WHERE NOT a:Probe AND NOT b:Probe "
                f"CREATE (a)-[:`{edge_type}`]->(b)", {"p": parent, "c": child})


def _reference(g, case):
    """``{urn: layer id or None}`` from ``place_all`` over the seeded nodes as the provider reads
    them back, as a search reads the view."""
    spec = PlacementSpec.from_config(case["view"])
    facts = {}
    for (node,) in g.query("MATCH (n) WHERE NOT n:Probe RETURN n").result_set:
        read = _node_from_props(node.properties, node.labels[0] if node.labels else None)
        facts[read.urn] = facts_from_graph_node(read)
    parents = {}
    for parent, child, _ in _parent_child(case):
        parents.setdefault(child, []).append(parent)
    return spec, {urn: p.layer_id for urn, p in place_all(spec, facts, parents).items()}


def _ids(case):
    return case["name"]


@pytest.mark.parametrize("case", CASES, ids=_ids)
def test_the_layer_filter_finds_what_the_canvas_draws(graph, case):
    if case["name"] in CYCLES:
        pytest.skip("place_all ignores a containment cycle's edges; the walk follows them")
    _seed(graph, case)
    spec, placed = _reference(graph, case)
    types = sorted({t for _, _, t in _parent_child(case)} | set(_containment(case)))
    urns = sorted(placed)
    for layer_id in sorted(spec.layer_ids) + ["no-such-layer"]:
        want = sorted(u for u in urns if placed[u] == layer_id)
        target = LayerTarget(spec, layer_id, "d")

        p = _Params()
        test = layer_test(target, "n", name=p.name, bind=p.bind, containment=types)
        rows = graph.query(f"MATCH (n) WHERE NOT n:Probe WITH n, {test} AS t "
                           f"RETURN n.urn, t", p.params).result_set
        assert all(t is True or t is False for _, t in rows), (layer_id, rows)
        assert sorted(u for u, t in rows if t) == want, layer_id

        p = _Params()
        test = layer_test(target, "_r", name=p.name, bind=p.bind, containment=types)
        far = sorted(r[0] for r in graph.query(
            f"MATCH (p:Probe) WITH p, ANY(_ok IN [(p)-[:PROBES]->(_r) | {test}] WHERE _ok) AS t "
            f"WHERE t RETURN p.target", p.params).result_set)
        assert far == want, ("as a far end", layer_id)


def test_cycles_do_not_fail_the_query(graph):
    """A cycle may place differently, but never errors or answers null."""
    for case in (c for c in CASES if c["name"] in CYCLES):
        _seed(graph, case)
        spec, _ = _reference(graph, case)
        types = sorted({t for _, _, t in _parent_child(case)} | set(_containment(case)))
        for layer_id in sorted(spec.layer_ids):
            p = _Params()
            test = layer_test(LayerTarget(spec, layer_id, "d"), "n", name=p.name, bind=p.bind,
                              containment=types)
            rows = graph.query(f"MATCH (n) WHERE NOT n:Probe RETURN {test}", p.params).result_set
            assert all(r[0] is True or r[0] is False for r in rows), case["name"]
