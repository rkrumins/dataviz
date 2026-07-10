"""Case-fold vocabulary matching (F7 audit finding).

FalkorDB type/label matching is case-SENSITIVE and the pipeline's only
spelling seam was the alias map — an edge-type or label casing present
in the graph but missing from the map was silently not scanned (the
worker injects zero entity aliases, so entity-label coverage there was
nil). The pipeline now fetches the graph's OBSERVED vocabulary
(db.relationshipTypes / db.labels) once per run and unions case-fold
matches for every declared spelling — including graphs that hold
SEVERAL casings of one type. Probe failure degrades to alias-only.
"""
import asyncio

import test_falkordb_materialize as base

from backend.app.providers import falkordb_materialize as mat


def _run(coro):
    return asyncio.run(coro)


class _VocabFake(base._FakeFalkor):
    async def ro_query(self, cypher, params=None, **kw):
        if "db.relationshipTypes" in cypher:
            return base._Result([[t] for t in self.typed_edges])
        if "db.labels" in cypher:
            labels = {label for _urn, label in self.nodes.values()}
            return base._Result([[lbl] for lbl in labels])
        return await super().ro_query(cypher, params, **kw)


def _seed_lowercase_graph(fake, *, containment_types=("contains",)):
    """Two chains with LOWERCASE labels and types; declared ontology uses
    different casings (Domain/Table/Column, CONTAINS/FLOWS)."""
    fake.add_node(1, "urn:domain_abc", "domain")
    fake.add_node(2, "urn:table_a", "table")
    fake.add_node(3, "urn:col_a", "column")
    fake.add_node(11, "urn:domain_def", "domain")
    fake.add_node(12, "urn:table_b", "table")
    fake.add_node(13, "urn:col_b", "column")
    ct = list(containment_types)
    fake.add_edge(ct[0], 0, 1, 2)
    fake.add_edge(ct[-1], 1, 2, 3)
    fake.add_edge(ct[0], 2, 11, 12)
    fake.add_edge(ct[-1], 3, 12, 13)
    fake.add_edge("flows", 10, 3, 13)
    fake.add_edge("flows", 11, 3, 13)
    return {"Domain": 0, "Table": 1, "Column": 2}


def test_declared_casings_match_observed_vocabulary():
    fake = _VocabFake()
    levels = _seed_lowercase_graph(fake)
    p = base._make_provider(fake, levels)      # alias maps empty

    result = _run(base._materialize(p))        # declares CONTAINS / FLOWS

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}, (
        "lowercase 'contains'/'flows' + 'domain'/'table' labels must "
        "aggregate under declared CONTAINS/FLOWS + Domain/Table levels"
    )
    # Level stamps resolved through the observed spellings.
    assert fake.agg[(1, 11)]["sl"] == 0 and fake.agg[(2, 12)]["sl"] == 1


def test_mixed_casings_of_one_type_are_all_scanned():
    fake = _VocabFake()
    levels = _seed_lowercase_graph(
        fake, containment_types=("contains", "CONTAINS"),
    )
    p = base._make_provider(fake, levels)

    result = _run(base._materialize(p))

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}, (
        "a graph holding BOTH casings of the containment type must load "
        "the full parent map (half-scanned containment breaks chains)"
    )


def test_vocab_probe_failure_degrades_to_alias_only():
    fake = base._FakeFalkor()                  # no db.* handlers → probe raises
    levels = base._seed_two_chain_graph(fake)  # exact-case graph
    p = base._make_provider(fake, levels)

    result = _run(base._materialize(p))

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}
