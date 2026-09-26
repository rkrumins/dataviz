"""Entity Type-Change Phase 1, Task 2: does an `entityType` change round-trip through
the draft `/changes` apply path AND the FalkorDB projection?

Part 1 — draft apply + read-back (pure functions, no DB/FalkorDB needed). The canvas
`POST /changes` endpoint (`graph.py::apply_graph_changes`) forwards an `update` op's raw
partial payload to `GraphVersioningService.apply_ops` -> `_apply_ops_once`, which (absent
an OCC `base_version`) does `new_vals[eid] = self._patch_payload(cur, patch)` — a plain
top-level-field patch. The node is then read back via `_graphnode_dict`. `entityType` is
an ordinary top-level field on the node payload (sibling of `layerAssignment`), so this
proves persistence + field-merge just work — no filtering to fix.

Part 2 — FalkorDB projection (`FalkorProjector._apply`, called directly — no Postgres, no
live FalkorDB; a fake graph client that reproduces real Cypher MERGE-by-label semantics).
`_apply` groups node upserts BY LABEL (the sanitized `entityType`) and issues one
`MERGE (n:{label} {urn: item.urn})` per label group (projection.py). A Cypher MERGE with a
labelled pattern only matches a node that ALREADY carries that label; a node whose label
changed doesn't match, so MERGE takes the CREATE branch — leaving the old-labelled node in
place AND creating a second node under the new label for the same urn/entity. This proves
the projector does not re-kind an existing node on an entityType change: it produces a
stale duplicate instead. This is the top risk flagged in the Entity Type-Change spec — NOT
fixed here (a projector redesign/relabel strategy is a human design decision); this test
only documents the gap with a reproduction.
"""
import asyncio
from types import SimpleNamespace

from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService, _graphnode_dict

# --------------------------------------------------------------------------------- #
# Part 1: draft `/changes` apply + read-back                                        #
# --------------------------------------------------------------------------------- #


def _seed_node(urn: str, entity_type: str, display_name: str, layer_assignment: str) -> dict:
    """A node's current stored payload (what `_current_values` would return)."""
    return {"urn": urn, "entityType": entity_type, "displayName": display_name,
            "layerAssignment": layer_assignment}


def _apply_update_op(current: dict, payload: dict) -> dict:
    """The exact merge `_apply_ops_once` performs for a plain (non-OCC) `update` op."""
    return GraphVersioningService._patch_payload(current, payload)


def _read_node(entity_id: str, urn: str, payload: dict) -> dict:
    """The reader-compatible shape a draft/committed node read returns."""
    return _graphnode_dict(entity_id, urn, payload)


def test_update_op_changes_entity_type_and_preserves_other_fields():
    node = _seed_node(urn="urn:x", entity_type="dataset", display_name="orders",
                       layer_assignment="staging")
    patched = _apply_update_op(node, {"entityType": "container"})
    got = _read_node("A", "urn:x", patched)
    assert got["entityType"] == "container"
    assert got["displayName"] == "orders"
    assert got["layerAssignment"] == "staging"


# --------------------------------------------------------------------------------- #
# Part 2: FalkorDB projection of an entityType change (documents the gap)           #
# --------------------------------------------------------------------------------- #


class _LabelAwareFakeGraph:
    """Interprets the projector's node-upsert Cypher with REAL MERGE-by-label semantics.

    Keyed by ``(label, urn)`` — unlike the simplified urn-only-keyed fake in
    ``test_versioning_projection.py`` (which overwrites-by-urn regardless of label and so
    can't surface this class of bug), this mirrors actual Cypher: ``MERGE (n:Label {urn:
    $u})`` only matches a node that ALREADY carries ``Label``; a differently-labelled node
    with the same urn does not match, so MERGE creates a NEW node instead of updating it.
    """

    def __init__(self):
        self.nodes: dict = {}   # (label, urn) -> item

    async def query(self, cypher: str, params: dict = None):
        params = params or {}
        # Before it writes, the projector reads the graph's registered
        # attribute names — what the native-property budget counts against
        # (``_registered_property_names``, projection.py:147). It is not a
        # node upsert, and an empty answer is the truth for this in-memory
        # fake: nothing is registered, so every key is admitted.
        if cypher.startswith("CALL db.propertyKeys()"):
            return SimpleNamespace(result_set=[])
        if cypher.startswith("CREATE (r:_PropReserve)") or cypher.startswith("MATCH (r:_PropReserve)"):
            return SimpleNamespace(result_set=[])
        if cypher.endswith("RETURN u, keys(n)"):                      # removed-property read
            label = cypher.split("MATCH (n:", 1)[1].split(" {urn:", 1)[0]
            return SimpleNamespace(result_set=[
                [u, list(self.nodes[(label, u)])] for u in params["urns"] if (label, u) in self.nodes])
        if " SET n:" in cypher and " REMOVE n:" in cypher:            # retype in place
            old = cypher.split("MATCH (n:", 1)[1].split(" {urn:", 1)[0]
            new = cypher.split(" SET n:", 1)[1].split(" REMOVE", 1)[0]
            for u in params["urns"]:
                if (old, u) in self.nodes:
                    self.nodes[(new, u)] = self.nodes.pop((old, u))
            return SimpleNamespace(result_set=[])
        assert cypher.startswith("UNWIND $batch AS item MERGE (n:"), f"unexpected cypher: {cypher!r}"
        label = cypher[len("UNWIND $batch AS item MERGE (n:"):].split(" {urn:", 1)[0]
        for it in params["batch"]:
            self.nodes[(label, it["urn"])] = it

    def rows_for_urn(self, urn: str):
        return [(label, item) for (label, u), item in self.nodes.items() if u == urn]


def test_projector_retypes_a_node_in_place_on_entity_type_change():
    """Re-projecting the SAME node ("A" / urn:x) after its entityType changes from "dataset"
    to "container": a MERGE under the new label alone used to create a second node and leave
    the old "dataset" one behind — two nodes for one entity (the gap this test pinned). The
    window now relabels the node in place first, so exactly one node remains, under the new
    label, keeping its id and edges.
    """
    fake = _LabelAwareFakeGraph()
    proj = FalkorProjector(graph_client_factory=lambda name, provider_id=None: fake)

    urn = "urn:x"
    v1 = {"urn": urn, "entityType": "dataset", "displayName": "orders", "layerAssignment": "staging"}
    asyncio.run(proj._apply(fake, [("A", urn, v1)], [], [], []))
    assert [l for l, _ in fake.rows_for_urn(urn)] == ["dataset"]

    v2 = {**v1, "entityType": "container"}          # the type-change update, same entity/urn
    asyncio.run(proj._relabel_in_place(fake, [(urn, "dataset", "container")]))
    asyncio.run(proj._apply(fake, [("A", urn, v2)], [], [], []))

    labels = sorted(l for l, _ in fake.rows_for_urn(urn))
    assert labels == ["container"], f"one node, under its new label — got {labels}"


if __name__ == "__main__":
    test_update_op_changes_entity_type_and_preserves_other_fields()
    test_projector_retypes_a_node_in_place_on_entity_type_change()
    print("entity-type round-trip + in-place retype: OK")
