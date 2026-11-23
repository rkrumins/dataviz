"""A relationship is looked up between its two ends, both found first by their urn indexes and
bound before the relationship is matched (``projection._between``), never walked to from one end.

FalkorDB plans the MATCH clauses of one query part as one pattern and walks it from one end,
expanding every relationship that node has for each row. In the 1M nodes + 2M edges scale run
the bench graph's root held 500,000 children: the rebuild's fingerprint lookups cost about 70 ms
a row, timed out at any batch size and ran four hours. Writing the ends as their own MATCH
clauses did not change that. A ``WITH`` between the ends and the relationship does: both ends are
then bound, and the relationship is found between them, as MERGE finds one. The live proof is
``tests/integration/test_hub_lookups_live.py``; this pins the statements' shape."""
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


def test_no_statement_matches_a_relationship_in_the_query_part_that_found_its_ends():
    # ``MATCH (b:L {urn: y}) MATCH (a)-[r:T]->(b)``, on one line or split over several literals:
    # the planner joins the clauses into one pattern and walks it from ``a``.
    joined = re.compile(r"\{urn: [^}]+\}\}\)\s*(?:\"\s*f?\")?\s*MATCH \(a\)-\[r")
    assert not joined.findall(SOURCE)


class _Recording:
    """A FalkorDB client that records what it is sent and answers nothing."""

    def __init__(self):
        self.sent = []

    async def ro_query(self, cypher, params=None, timeout=None):
        self.sent.append(cypher)
        return type("R", (), {"result_set": []})()

    query = ro_query


def _between(cypher: str, rel: str) -> bool:
    found = re.search(r"MATCH \(a:\S+ \{urn: [\w.]+\}\) MATCH \(b:\S+ \{urn: [\w.]+\}\) "
                      r"WITH (\w+), a, b "
                      r"MATCH \(a\)-\[r:`?" + re.escape(rel) + r"`?\]->\(b\)", cypher)
    return found is not None and cypher.startswith(f"UNWIND $batch AS {found.group(1)} ")


def test_a_relationships_fingerprint_is_read_between_its_two_ends():
    client = _Recording()
    proj = FalkorProjector(graph_client_factory=lambda *a: client)
    keys = [("Layer", "urn:root", "HAS", "Object", f"urn:o{k}") for k in range(3)]
    asyncio.run(proj._held_fingerprints(client, "edge", keys))
    (cypher,) = client.sent
    assert _between(cypher, "HAS"), cypher
    assert cypher.endswith("RETURN it.src, it.tgt, r.gvHash")


def test_a_relationship_deleted_by_its_ends_or_its_id_is_found_between_them():
    for cypher in (projection._delete_edges_by_key_cypher("HAS", "Layer", "Object"),
                   projection._delete_edges_cypher("HAS", "Layer", "Object"),
                   projection._delete_edge_ids_cypher("`HAS`", "Layer", "Object")):
        assert _between(cypher, "HAS") and cypher.endswith("DELETE r"), cypher


def test_a_summary_cell_is_read_and_deleted_between_its_two_ends():
    read = projection._rollup_read_cypher("Layer", "Object")
    assert _between(read, "AGGREGATED"), read
    assert "{urn: item.s}" in read and "{urn: item.t}" in read
    assert read.endswith("RETURN item.s, item.t, r.weight, r.sourceEdgeTypes, r.gvSeq")
    delete = projection._rollup_delete_cypher("Layer", "Object")
    assert _between(delete, "AGGREGATED") and delete.endswith("DELETE r"), delete
