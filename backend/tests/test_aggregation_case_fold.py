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


class _EmptyRelCatalogFake(base._FakeFalkor):
    """``db.relationshipTypes()`` returns EMPTY (a stale/partial schema
    catalog) even though the graph holds edges — the exact failure that left
    declared ``CONTAINS`` scanning nothing and folded the hierarchy flat. The
    label catalog is healthy; only the rel catalog is broken, so the test
    isolates R1's edge-type scan fallback."""

    async def ro_query(self, cypher, params=None, **kw):
        if "db.relationshipTypes" in cypher:
            return base._Result([])                     # empty rel catalog
        if "db.labels" in cypher:
            labels = {label for _urn, label in self.nodes.values()}
            return base._Result([[lbl] for lbl in labels])
        if "RETURN DISTINCT type(r)" in cypher:         # R1 edge-scan fallback
            return base._Result([[t] for t in self.typed_edges])
        return await super().ro_query(cypher, params, **kw)


def test_empty_rel_catalog_recovered_via_edge_scan():
    """R1: an empty db.relationshipTypes() must not fold the hierarchy flat.
    The edge-scan fallback recovers the observed casings so declared
    CONTAINS/FLOWS still match the graph's lowercase contains/flows."""
    fake = _EmptyRelCatalogFake()
    levels = _seed_lowercase_graph(fake)
    p = base._make_provider(fake, levels)

    result = _run(base._materialize(p))

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}, (
        "empty relationship catalog + edges present must recover the observed "
        "vocabulary via edge scan, not scan zero edges"
    )


def test_provider_alias_rel_types_case_fold_floor():
    """R2: the provider's declared→physical resolution unions observed
    case-fold variants even when the injected alias map is EMPTY — so
    trace / top-level / containment accessors can't silently miss a
    differently-cased graph."""
    p = base._make_provider(base._FakeFalkor())
    p.set_source_type_aliases({})                       # empty alias map
    # Reliable observed vocabulary (as get_ontology_metadata would populate).
    p._observed_rel_types = {"to", "To", "has"}

    out = set(p._alias_rel_types(["TO"]))
    assert {"TO", "to", "To"} <= out, (
        "declared TO must resolve to every observed case-fold variant"
    )
    # A declared type with no observed fold is left exactly as-is (the floor
    # only ADDS same-casefold spellings — it never invents or drops a type).
    assert set(p._alias_rel_types(["FLOWS"])) == {"FLOWS"}


def test_provider_case_fold_floor_is_noop_without_observed_vocab():
    """The floor is inert until the observed vocabulary is known, so a
    provider that never probed keeps the exact alias-map-only behaviour."""
    p = base._make_provider(base._FakeFalkor())
    p.set_source_type_aliases({"TO": ["To"]})
    # No _observed_rel_types attribute → pure alias translation, no floor.
    assert p._alias_rel_types(["TO"]) == ["To"]


def test_declared_types_matching_nothing_observed_warn_loudly(caplog):
    """Completeness diagnosability: a declared type whose spelling matches
    NOTHING in the graph (not exact, not alias, not case-fold) scans zero
    edges — that must be loud, not silent, or missing aggregations look
    like an empty source."""
    import logging

    fake = _VocabFake()
    levels = _seed_lowercase_graph(fake)
    p = base._make_provider(fake, levels)

    with caplog.at_level(logging.WARNING):
        result = _run(mat.materialize_aggregated_edges(
            p,
            containment_edge_types=["CONTAINS"],
            lineage_edge_types=["FLOWS", "TRANSFORMS"],   # TRANSFORMS: nowhere
        ))

    assert result["errors"] == 0
    joined = " ".join(r.message for r in caplog.records)
    assert "TRANSFORMS" in joined, "zero-match declared type must be warned about"
    assert "FLOWS" not in joined.replace("TRANSFORMS", ""), (
        "fold-matched types are scanned — they must not be reported as unmatched"
    )


def test_unmatched_edge_types_surface_as_job_advisory():
    """Phase IV: the zero-match casing gap is not only logged — it lands on the
    job's run_stats as a structured advisory, so the job detail shows WHY a run
    scanned fewer edges than expected."""
    fake = _VocabFake()
    levels = _seed_lowercase_graph(fake)
    p = base._make_provider(fake, levels)

    result = _run(mat.materialize_aggregated_edges(
        p,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS", "TRANSFORMS"],   # TRANSFORMS: nowhere
    ))

    advisories = result["run_stats"].get("advisories", [])
    hit = next((a for a in advisories if a["kind"] == "edge_types_unmatched"), None)
    assert hit is not None, "unmatched declared edge type must surface as an advisory"
    assert "TRANSFORMS" in hit["message"]
