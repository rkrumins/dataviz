"""RC1 regression: the versioned FalkorDB neighbors read must recover entityType from the
node LABEL.

The projector (and save_custom_graph) write entityType ONLY as the FalkorDB label, never as a
node property. ``_falkor_neighbors`` used to build nodes with ``_node_from_props(props)`` — no
label — so entityType collapsed to "unknown", and the canvas then could neither resolve the node
type (→ URN/`Unknown` labels) nor apply containment rules (→ flat hierarchy). Every other FalkorDB
reader passes ``labels[0]`` (``_extract_node_from_result``); this asserts the neighbors read now
does too.
"""
import asyncio
from types import SimpleNamespace

from backend.app.api.v1.endpoints.versioning import _falkor_neighbors


class _Cell:
    """A FalkorDB result node: exposes .properties and .labels like the real client."""

    def __init__(self, properties, labels):
        self.properties = properties
        self.labels = labels


class _FakeGraph:
    def __init__(self, node_rows):
        self._node_rows = node_rows

    async def query(self, cypher, params=None):
        # First query is the neighborhood walk (RETURN DISTINCT x); the follow-up edge query
        # (MATCH (a)-[r]->(b)) returns nothing for this node-shape test.
        if "RETURN DISTINCT x" in cypher:
            return SimpleNamespace(result_set=self._node_rows)
        return SimpleNamespace(result_set=[])


def _neighbors(node_rows):
    g = _FakeGraph(node_rows)
    return asyncio.run(_falkor_neighbors(
        g, urn="urn:layer:a", depth=1, direction="both", edge_types=None, limit=100))


def test_entity_type_recovered_from_label():
    row = [_Cell({"urn": "urn:layer:a", "displayName": "Sales"}, ["Layer"])]
    out = _neighbors([row])
    assert len(out["nodes"]) == 1
    n = out["nodes"][0]
    assert n["entityType"] == "Layer", "entityType must come from the label, not 'unknown'"
    assert n["displayName"] == "Sales"


def test_missing_label_still_degrades_to_unknown():
    # A label-less node (legacy/edge case) must not blow up — it keeps the prior fallback.
    row = [_Cell({"urn": "urn:x", "displayName": "x"}, [])]
    out = _neighbors([row])
    assert out["nodes"][0]["entityType"] == "unknown"
