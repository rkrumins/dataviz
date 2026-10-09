"""The placement contract differs from today's server placement exactly where it is recorded.

``backend.scripts.placement_dry_run.diff_placements`` (the dry run's core) runs the legacy
``AssignmentEngine``, fed the request the canvas builds, and the contract over every case of the
shared corpus (``fixtures/placement/``). Each deliberate difference is recorded with its reason in
``fixtures/placement_legacy_marks.json``: what the server answers today, for exactly the nodes
whose member layer changes, or ``"rejected"`` when the server refuses the config. The marks were
generated with ``diff_placements`` and reviewed; a new difference, or a mark that no longer
holds, fails here. This is also the dry run's own test.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.services.view_placement import child_is_source
from backend.common.models.graph import GraphEdge, GraphNode
from backend.scripts.placement_dry_run import REJECTED, diff_placements

_FIXTURES = Path(__file__).parent / "fixtures"
_CASES = [case for path in sorted((_FIXTURES / "placement").glob("*.json"))
          for case in json.loads(path.read_text())["cases"]]
_MARKS = json.loads((_FIXTURES / "placement_legacy_marks.json").read_text())


def _graph(case: dict):
    nodes = [GraphNode(urn=n["urn"], entityType=n.get("entityType", ""),
                       displayName=n.get("displayName", n["urn"]), tags=n.get("tags", []),
                       layerAssignment=n.get("layerAssignment"), properties=n.get("properties", {}))
             for n in case["nodes"]]
    edges = [GraphEdge(id=f"e{i}", sourceUrn=e["source"], targetUrn=e["target"], edgeType=e["edgeType"])
             for i, e in enumerate(case.get("edges", []))]
    containment = {t.upper(): child_is_source(t, d)
                   for t, d in ((case.get("ontology") or {}).get("containment") or {}).items()}
    return nodes, edges, containment


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
async def test_legacy_differs_only_where_the_corpus_says(case):
    nodes, edges, containment = _graph(case)
    diff = await diff_placements(
        case["view"], containment, nodes, edges, (case.get("context") or {}).get("createdInBranch", []))
    want = _MARKS.get(case["name"], {}).get("legacy", {})
    if want == REJECTED:
        assert diff == REJECTED, case["name"]
        return
    assert diff != REJECTED, f"{case['name']}: the server refuses this config, but no mark says so"
    assert {urn: old for urn, (old, _new) in diff.items()} == want, case["summary"]


def test_every_mark_names_a_corpus_case_and_its_reason():
    names = {c["name"] for c in _CASES}
    assert _CASES, "the corpus is empty"
    for name, mark in _MARKS.items():
        assert name in names, f"{name} is not a corpus case"
        assert set(mark) == {"why", "legacy"}, name
        assert isinstance(mark["why"], str) and mark["why"].strip(), f"{name}: say why it differs"
        assert mark["legacy"] == REJECTED or (isinstance(mark["legacy"], dict) and mark["legacy"]), name
