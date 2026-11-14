"""A relationship is looked up between its two ends, both found first by their urn indexes, and
never walked to from one end alone. From one end FalkorDB expands every relationship that node
has: in the 1M nodes + 2M edges scale run a single container held about 333,000 children, and the
rebuild's per-edge fingerprint lookups timed out at any batch size for four hours. Bound at both
ends, the relationship between them is found directly (FalkorDB's Expand Into), whatever either
end's degree."""
import asyncio
import pathlib
import re

from backend.app.services.versioning import projection
from backend.app.services.versioning.projection import FalkorProjector

SOURCE = pathlib.Path(projection.__file__).read_text()


def test_no_statement_walks_from_one_end_to_find_a_relationship_to_another():
    # ``(a:L {urn: x})-[r:T]->(b:L {urn: y})`` in one pattern expands from ``a``, written on one
    # line or split over several literals.
    walked = re.compile(r"\{urn: [\w.]+\}\}\)(?:\"\s*f\")?-\[r:[^\]]*\]->(?:\"\s*f\")?\(b:")
    assert not walked.findall(SOURCE)


class _Recording:
    """A FalkorDB client that records what it is sent and answers nothing."""

    def __init__(self):
        self.sent = []

    async def ro_query(self, cypher, params=None, timeout=None):
        self.sent.append(cypher)
        return type("R", (), {"result_set": []})()

    query = ro_query


def _bound_at_both_ends(cypher: str, rel: str) -> bool:
    joined = re.search(r"MATCH \(a:\S+ \{urn: [\w.]+\}\) MATCH \(b:\S+ \{urn: [\w.]+\}\) "
                       r"MATCH \(a\)-\[r:`?" + re.escape(rel) + r"`?\]->\(b\)", cypher)
    return joined is not None


def test_a_relationships_fingerprint_is_read_between_its_two_ends():
    client = _Recording()
    proj = FalkorProjector(graph_client_factory=lambda *a: client)
    keys = [("Layer", "urn:root", "HAS", "Object", f"urn:o{k}") for k in range(3)]
    asyncio.run(proj._held_fingerprints(client, "edge", keys))
    (cypher,) = client.sent
    assert _bound_at_both_ends(cypher, "HAS"), cypher
    assert cypher.endswith("RETURN it.src, it.tgt, r.gvHash")


def test_a_relationship_deleted_by_its_ends_or_its_id_is_found_between_them():
    for cypher in (projection._delete_edges_by_key_cypher("HAS", "Layer", "Object"),
                   projection._delete_edges_cypher("HAS", "Layer", "Object")):
        assert _bound_at_both_ends(cypher, "HAS") and cypher.endswith("DELETE r"), cypher
