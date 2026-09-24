"""Live: lineage bridges against a REAL FalkorDB.

The unit suite proves the walker against an oracle and the FalkorDB adapter
against a fake that string-matches its Cypher. A fake cannot catch what the
engine itself rejects — FalkorDB refuses query shapes a string match accepts
(see ``_collect_lineage_seed``'s note on ``WITH [f] + collect(...)``). So the
new region enumeration, and the whole walk through the closure walk's own
reads, run here on the engine the platform ships:

* the A→B→…→G chain at column grain, picked A, C, F → A⇢C (2), C⇢F (3);
* region ownership with nesting, a blocking member and page trimming;
* relationship types spelled differently in the graph than in the ontology;
* the hidden steps behind a hop, hydrated with their containment ancestors.

Run with FalkorDB reachable::

    RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_lineage_bridges_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest

from backend.app.providers import falkordb_bridges as fb
from backend.app.providers.falkordb_bridges import FalkorBridgeCallbacks
from backend.app.providers.falkordb_provider import FalkorDBProvider

pytestmark = pytest.mark.asyncio

skip_if_down = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live bridges E2E.",
)

_CHAIN = (
    "CREATE "
    + ", ".join(f"(t{x}:Table {{urn:'{x}'}})-[:CONTAINS]->(c{x}:Column {{urn:'{x}.c'}})" for x in "ABCDEFG")
    + ", "
    + ", ".join(f"(c{a})-[:FLOWS]->(c{b})" for a, b in zip("ABCDEF", "BCDEFG"))
)


async def _provider(cypher: str) -> FalkorDBProvider:
    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))
    p = FalkorDBProvider(host=host, port=port, graph_name=f"gvt_bridges_{uuid.uuid4().hex[:8]}")
    p._entity_type_levels = {"Domain": 0, "Table": 1, "Column": 2}
    await p._ensure_connected()
    await p._graph.query(cypher)
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    return p


async def _drop(p: FalkorDBProvider) -> None:
    try:
        await p._graph.delete()
    except Exception:
        pass


def _links(result):
    return [(link.source, link.target, link.hops) for link in result.links]


@skip_if_down
async def test_the_chain_keeps_its_story_as_virtual_hops():
    p = await _provider(_CHAIN)
    try:
        result = await p.lineage_bridges(
            members={"A": True, "C": True, "F": True}, origins=None, direction="downstream",
            max_hops=10, max_nodes=1000, lineage_edge_types=["FLOWS"],
            containment_edge_types=["CONTAINS"], timeout_ms=20_000,
        )
        assert _links(result) == [("A", "C", 2), ("C", "F", 3)]
        assert result.incomplete == [] and not result.truncated

        upstream = await p.lineage_bridges(
            members={"A": True, "C": True, "F": True}, origins=["F"], direction="upstream",
            max_hops=10, max_nodes=1000, lineage_edge_types=["FLOWS"],
            containment_edge_types=["CONTAINS"], timeout_ms=20_000,
        )
        assert _links(upstream) == [("C", "F", 3)]
    finally:
        await _drop(p)


@skip_if_down
async def test_region_ownership_nesting_blocking_and_paging(monkeypatch):
    monkeypatch.setattr(fb, "REGION_PAGE_ROWS", 2)
    p = await _provider(
        "CREATE (d:Domain {urn:'D'}), "
        "(d)-[:CONTAINS]->(t1:Table {urn:'T1'})-[:CONTAINS]->(c1:Column {urn:'T1.c'}), "
        "(d)-[:CONTAINS]->(t2:Table {urn:'T2'})-[:CONTAINS]->(c2:Column {urn:'T2.c'}), "
        "(d)-[:CONTAINS]->(t3:Table {urn:'T3'})-[:CONTAINS]->(c3:Column {urn:'T3.c'}), "
        "(z:Column {urn:'Z'}), (c1)-[:FLOWS]->(z), (c2)-[:FLOWS]->(z), (c3)-[:FLOWS]->(z)"
    )
    try:
        cb = FalkorBridgeCallbacks(p, ["FLOWS"], ["CONTAINS"])
        seeds = await cb.region_seeds({"D": True, "T1": True, "T2": False}, cap=100, timeout=10)
        # T1.c: under D and T1, T1 is deeper. T2.c: T2 blocks. T3.c: only D.
        assert seeds.owner == {"T1.c": "T1", "T3.c": "D"}
        assert seeds.complete and not seeds.failed
    finally:
        await _drop(p)


@skip_if_down
async def test_types_spelled_differently_in_the_graph_are_aligned():
    p = await _provider(_CHAIN.replace(":FLOWS]", ":flows]").replace(":CONTAINS]", ":contains]"))
    try:
        await p.get_ontology_metadata()          # learns the graph's own spellings
        result = await p.lineage_bridges(
            members={"A": True, "C": True}, origins=None, direction="downstream",
            max_hops=10, max_nodes=1000, lineage_edge_types=["FLOWS"],
            containment_edge_types=["CONTAINS"], timeout_ms=20_000,
        )
        assert _links(result) == [("A", "C", 2)]
    finally:
        await _drop(p)


@skip_if_down
async def test_the_hidden_steps_behind_a_hop():
    p = await _provider(_CHAIN)
    try:
        result = await p.lineage_bridge_path(
            members={"A": True, "C": True, "F": True}, source="C", target="F",
            max_hops=10, max_nodes=1000, lineage_edge_types=["FLOWS"],
            containment_edge_types=["CONTAINS"], timeout_ms=20_000,
        )
        assert result.hops == 3
        assert result.hidden_urns == ["D.c", "E.c"]
        assert result.endpoint_urns == ["C.c", "F.c"]
        assert [(e.source_urn, e.target_urn) for e in result.edges] == [
            ("C.c", "D.c"), ("D.c", "E.c"), ("E.c", "F.c"),
        ]
        assert result.ancestor_chains["D.c"] == ["D"]
        assert {n.urn for n in result.nodes} >= {"D.c", "E.c", "D", "E"}
        assert not result.truncated
    finally:
        await _drop(p)
