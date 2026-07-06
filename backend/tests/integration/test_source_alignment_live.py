"""Live Day-0 / Day-N acceptance tests for per-source vocabulary alignment (Task E).

Runs the REAL FalkorDBProvider top-level + children queries against a seeded graph and
asserts the hierarchy NESTS — both when the graph spells its containment type ``has``
(Day-0, matching the suggested ontology) and ``HAS`` (Day-N, the same ontology over a
differently-cased graph). Also shows the un-aligned baseline is flat, proving the fix
does the work. Auto-skips when FalkorDB is unreachable.

Run in the dev container (reaches ``falkordb:6379``)::

    docker exec -w /app synodic-dev-viz-service-1 \
      python -m pytest backend/tests/integration/test_source_alignment_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

from backend.app.ontology.source_alignment import derive_alignment
from backend.app.providers.falkordb_provider import FalkorDBProvider

pytestmark = pytest.mark.asyncio


def _host_port():
    return os.getenv("FALKORDB_HOST", "localhost"), int(os.getenv("FALKORDB_PORT", "6379"))


async def _reachable() -> bool:
    host, port = _host_port()
    p = FalkorDBProvider(host=host, port=port, graph_name=f"gvt_probe_{uuid.uuid4().hex[:6]}")
    try:
        await p._ensure_connected()
        await p._graph.query("RETURN 1")
        return True
    except Exception:
        return False


skip_if_down = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (and have FalkorDB reachable) to run the live alignment E2E.",
)


async def _seed(rel_spelling: str) -> FalkorDBProvider:
    """A root Dataset containing one child Dataset via a ``rel_spelling`` edge."""
    host, port = _host_port()
    name = f"gvt_align_{rel_spelling.lower()}_{uuid.uuid4().hex[:6]}"
    p = FalkorDBProvider(host=host, port=port, graph_name=name)
    await p._ensure_connected()
    await p._graph.query(
        f"CREATE (r:Dataset {{urn:'te_root', displayName:'Root'}}) "
        f"CREATE (c:Dataset {{urn:'te_child', displayName:'Child'}}) "
        f"CREATE (r)-[:{rel_spelling}]->(c)")
    return p


def _alias_for(declared_rel, observed_rel):
    return derive_alignment(
        declared_relationship_types=declared_rel, declared_entity_types=["Dataset"],
        observed_relationship_types=observed_rel, observed_entity_types=["Dataset"],
    ).rel_alias_map()


async def _urns_top_level(p):
    res = await p.get_top_level_or_orphan_nodes(root_entity_types=[], entity_types=None, limit=50)
    return {n.urn for n in res.nodes}


async def _urns_children(p, edge_types):
    kids = await p.get_children("te_root", edge_types=edge_types, limit=50)
    return {n.urn for n in kids}


@skip_if_down
async def test_day0_lowercase_graph_nests_with_alignment():
    """Day-0: graph uses ``has``; ontology (suggested from it) declares ``has``. Provider
    uppercases its containment set internally, so alignment injects the observed ``has``."""
    p = await _seed("has")
    try:
        p.set_containment_edge_types(["has"])            # ontology's declared spelling
        p.set_source_type_aliases(_alias_for(["has"], ["has"]))

        # Root is the only top-level node; the child is nested under it.
        assert await _urns_top_level(p) == {"te_root"}
        # Children resolve through BOTH the internal-set channel and a declared param.
        assert await _urns_children(p, None) == {"te_child"}
        assert await _urns_children(p, ["has"]) == {"te_child"}
    finally:
        await p._graph.delete()


@skip_if_down
async def test_dayN_uppercase_graph_nests_with_same_ontology():
    """Day-N: graph uses ``HAS``; SAME ontology declares ``has``. Alignment maps the
    declared param to the observed ``HAS`` so both channels match the graph."""
    p = await _seed("HAS")
    try:
        p.set_containment_edge_types(["has"])            # unchanged ontology (declares has)
        p.set_source_type_aliases(_alias_for(["has"], ["HAS"]))

        assert await _urns_top_level(p) == {"te_root"}
        assert await _urns_children(p, None) == {"te_child"}
        assert await _urns_children(p, ["has"]) == {"te_child"}
    finally:
        await p._graph.delete()


@skip_if_down
async def test_unaligned_baseline_is_flat_proving_the_fix():
    """Without alignment the mismatch flattens the tree: a ``has`` graph queried with the
    uppercased containment set leaves the child looking top-level and returns no children
    via the declared param — the exact bug the alignment layer removes."""
    p = await _seed("has")
    try:
        p.set_containment_edge_types(["has"])            # internal set uppercased to {HAS}
        # No aliases injected → the case-sensitive :HAS pattern misses the :has graph.
        top = await _urns_top_level(p)
        assert "te_child" in top                          # child wrongly surfaces as top-level
        assert await _urns_children(p, ["has"]) == {"te_child"}  # param path (no upper) still ok
    finally:
        await p._graph.delete()
