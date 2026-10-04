"""The shared placement corpus, run against the Python reference.

``tests/fixtures/placement/*.json`` pins what the one placement contract answers for whole views.
``frontend/src/lib/placement/__tests__/conformance.test.ts`` runs the same files against the
TypeScript twin, so the server and the canvas cannot drift apart without a red build on both
sides. A case is a FULL stored view config, the graph nodes and edges, and the expected placement
of every node; some cases also pin the write-path policy (``suggest``) and the rules the compiled
view reports inert (``inert``).

``_place`` is the only code here that knows the contract's API.
"""
import json
import re
from pathlib import Path

import pytest
import yaml

from backend.app.services.view_placement import (
    PlacementSpec,
    child_is_source,
    containment_parents,
    facts_from_graph_node,
    place_all,
    suggest_placement,
)
from backend.common.models.graph import GraphEdge, GraphNode

_REPO = Path(__file__).resolve().parents[2]
_CORPUS = Path(__file__).parent / "fixtures" / "placement"
_FRONTEND_RUNNER = _REPO / "frontend" / "src" / "lib" / "placement" / "__tests__" / "conformance.test.ts"
_FRONTEND_WORKFLOW = _REPO / ".github" / "workflows" / "frontend-tests.yml"

_CASE_KEYS = {"name", "summary", "view", "ontology", "nodes", "edges", "context", "expect", "suggest",
              "legacy", "inert"}
_NODE_KEYS = {"urn", "entityType", "displayName", "tags", "layerAssignment", "properties"}
_EDGE_KEYS = {"source", "target", "edgeType"}
_PLACEMENT_KEYS = {"layerId", "source", "ruleId", "inheritedFrom", "staleExplicit", "ambiguousParent"}
_SOURCES = {"explicit", "inherited", "stamped", "rule", "fallback", "none"}
_SUGGEST_KEYS = {"urn", "chosenLayerId", "defaultLayerId", "expect"}
_DIRECTIONS = {None, "source-to-target", "target-to-source", "parent-to-child", "child-to-parent",
               "bidirectional"}


def _load():
    return [case for path in sorted(_CORPUS.glob("*.json"))
            for case in json.loads(path.read_text(encoding="utf-8"))["cases"]]


_CASES = _load()
_EACH = pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
_SUGGESTING = [c for c in _CASES if c.get("suggest")]
_INERT = [c for c in _CASES if "inert" in c]


def _graph_node(node):
    return GraphNode(urn=node["urn"], entityType=node.get("entityType", ""),
                     displayName=node.get("displayName", node["urn"]), tags=node.get("tags", []),
                     layerAssignment=node.get("layerAssignment"), properties=node.get("properties", {}))


def _place(case, *, reverse=False):
    """``(spec, facts by urn, {urn: placement json})`` for one case."""
    nodes, edges = case["nodes"], case.get("edges", [])
    if reverse:
        nodes, edges = nodes[::-1], edges[::-1]
    spec = PlacementSpec.from_config(case["view"])
    facts = {n["urn"]: facts_from_graph_node(_graph_node(n)) for n in nodes}
    containment = {edge_type.upper(): child_is_source(edge_type, direction)
                   for edge_type, direction in case.get("ontology", {}).get("containment", {}).items()}
    parents = containment_parents(
        (GraphEdge(id=f"e{i}", sourceUrn=e["source"], targetUrn=e["target"], edgeType=e["edgeType"])
         for i, e in enumerate(edges)),
        containment)
    created = frozenset(case.get("context", {}).get("createdInBranch", ()))
    placed = place_all(spec, facts, parents, created)
    return spec, facts, {urn: p.to_json() for urn, p in placed.items()}


def _compact(placement):
    """The corpus compares after dropping null and false values."""
    return {k: v for k, v in placement.items() if v is not None and v is not False}


@_EACH
def test_placement_matches_the_corpus(case):
    _, _, placed = _place(case)
    assert {urn: _compact(p) for urn, p in placed.items()} == case["expect"]


@_EACH
def test_placement_does_not_depend_on_load_order(case):
    """Every case again with its nodes and edges reversed: the canvas and the server load the same
    graph in different orders."""
    _, _, placed = _place(case, reverse=True)
    assert {urn: _compact(p) for urn, p in placed.items()} == case["expect"]


@pytest.mark.parametrize("case", _SUGGESTING, ids=[c["name"] for c in _SUGGESTING])
def test_suggest_matches_the_corpus(case):
    spec, facts, _ = _place(case)
    for s in case["suggest"]:
        layer_id, pin = suggest_placement(spec, facts[s["urn"]], s.get("chosenLayerId"),
                                          s.get("defaultLayerId"))
        assert {"layerId": layer_id, "pin": pin} == s["expect"], s


@pytest.mark.parametrize("case", _INERT, ids=[c["name"] for c in _INERT])
def test_inert_rules_match_the_corpus(case):
    spec, _, _ = _place(case)
    assert sorted([layer_id, rule_id] for layer_id, rule_id, _reason in spec.inert) == case["inert"]


@_EACH
def test_every_case_is_well_formed(case):
    """A malformed case passes or fails for the wrong reason, on one side only."""
    assert set(case) <= _CASE_KEYS, set(case) - _CASE_KEYS
    assert {"name", "summary", "view", "nodes", "expect"} <= set(case)
    urns = [n["urn"] for n in case["nodes"]]
    assert len(urns) == len(set(urns)), "node urns must be unique"
    for node in case["nodes"]:
        assert set(node) <= _NODE_KEYS, set(node) - _NODE_KEYS
    assert set(case["expect"]) == set(urns), "expect must cover every node and nothing else"
    for placement in case["expect"].values():
        assert set(placement) <= _PLACEMENT_KEYS, set(placement) - _PLACEMENT_KEYS
        assert placement["source"] in _SOURCES
        assert placement == _compact(placement), "null and false values are omitted"

    edges = case.get("edges", [])
    assert not edges or "ontology" in case, "edges need an ontology to orient them"
    if "ontology" in case:
        assert set(case["ontology"]) == {"containment"}
        assert set(case["ontology"]["containment"].values()) <= _DIRECTIONS
    for edge in edges:
        assert set(edge) == _EDGE_KEYS, edge
        assert {edge["source"], edge["target"]} <= set(urns), edge
    if "context" in case:
        assert set(case["context"]) == {"createdInBranch"}
        assert set(case["context"]["createdInBranch"]) <= set(urns)
    for s in case.get("suggest", []):
        assert set(s) <= _SUGGEST_KEYS and s["urn"] in urns, s
        assert set(s["expect"]) == {"layerId", "pin"}, s
    if "inert" in case:
        assert all(isinstance(p, list) and len(p) == 2 for p in case["inert"]), case["inert"]
        assert case["inert"] == sorted(case["inert"]), "inert pairs are sorted"


def test_the_corpus_names_are_unique_kebab_case():
    names = [c["name"] for c in _CASES]
    assert len(names) >= 40, "the corpus is (nearly) empty"
    assert len(names) == len(set(names)), "case names are test ids: keep them unique"
    assert all(re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", n) for n in names), names


def test_the_frontend_runs_the_same_corpus():
    """The corpus only holds the twins together if the TypeScript runner reads it and the REQUIRED
    frontend job runs that runner — on every pull request, including one that only edits the
    corpus here."""
    assert _FRONTEND_RUNNER.is_file(), f"{_FRONTEND_RUNNER} is missing"
    assert "backend/tests/fixtures/placement" in _FRONTEND_RUNNER.read_text(encoding="utf-8"), (
        "The TypeScript runner no longer reads this corpus.")

    workflow = yaml.safe_load(_FRONTEND_WORKFLOW.read_text())
    triggers = workflow.get("on", workflow.get(True))  # YAML 1.1 reads a bare `on` as True
    assert "pull_request" in triggers
    pull_request = (triggers["pull_request"] if isinstance(triggers, dict) else None) or {}
    assert not {"paths", "paths-ignore"} & set(pull_request), (
        "A paths filter would skip the frontend job when only the corpus changes.")
    runs = [(job, step) for job in workflow["jobs"].values() for step in job.get("steps", [])
            if str(step.get("run", "")).strip().startswith("npx vitest run")]
    assert runs, f"{_FRONTEND_WORKFLOW.name} no longer runs `npx vitest run`"
    for job, step in runs:
        assert not job.get("continue-on-error") and not step.get("continue-on-error"), (
            "The vitest job became informational; the corpus is ungated on the frontend.")
        flags = step["run"].strip().split()[3:]
        assert all(f.startswith("-") for f in flags), (
            f"`{step['run'].strip()}` narrows the suite to a path; the corpus runner may not run.")
