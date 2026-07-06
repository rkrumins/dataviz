"""Unit tests for per-source vocabulary alignment (Task E).

Covers the pure derivation core (identity / case-variant / missing / same-source
multi-variant, explicit-beats-auto, schema-hash), the seed-time row canonicalization,
and the provider's declared→observed alias translation.
"""
from __future__ import annotations

from backend.app.ontology.source_alignment import (
    CASE_VARIANT,
    IDENTITY,
    MISSING_OBSERVED,
    MULTI_VARIANT,
    derive_alignment,
)


def _align(declared_rel, observed_rel, *, declared_ent=(), observed_ent=(),
           explicit_rel=None, explicit_ent=None):
    return derive_alignment(
        declared_relationship_types=declared_rel,
        declared_entity_types=declared_ent,
        observed_relationship_types=observed_rel,
        observed_entity_types=observed_ent,
        explicit_relationship_mappings=explicit_rel,
        explicit_entity_mappings=explicit_ent,
    )


# ── Derivation ────────────────────────────────────────────────────────────────

def test_identity_when_spelling_matches():
    """Day-0: ontology declares the graph's own spelling (has/to) → no user drift. The
    alias map is still populated (HAS→has) because the provider uppercases its containment
    set internally, so the observed lowercase spelling must be injected for the case-
    sensitive Cypher pattern to match."""
    a = _align(["has", "to"], ["has", "to"])
    assert a.relationship_entries["has"].kind == IDENTITY
    assert a.relationship_entries["to"].kind == IDENTITY
    assert a.has_drift is False
    assert a.rel_alias_map() == {"HAS": ["has"], "TO": ["to"]}


def test_already_uppercase_governed_graph_needs_no_alias():
    """The common governed case: an uppercase-declared type the graph spells the same way
    needs no translation — empty alias map (cheap short-circuit)."""
    a = _align(["HAS", "TO"], ["HAS", "TO"])
    assert a.has_drift is False
    assert a.rel_alias_map() == {}


def test_case_variant_maps_declared_to_observed():
    """Day-N: same has/to ontology over a HAS/TO graph → case-variant, aliases map the
    UPPERCASED declared key to the observed spelling so a case-sensitive query matches."""
    a = _align(["has", "to"], ["HAS", "TO"])
    assert a.relationship_entries["has"].kind == CASE_VARIANT
    assert a.relationship_entries["has"].observed == ["HAS"]
    assert a.has_drift is True
    assert a.rel_alias_map() == {"HAS": ["HAS"], "TO": ["TO"]}


def test_missing_observed_is_drift_but_not_aliased():
    """A declared type absent from the graph is drift (informational) but produces no
    alias (nothing to remap to — the query harmlessly matches nothing)."""
    a = _align(["has", "owns"], ["has"])
    assert a.relationship_entries["owns"].kind == MISSING_OBSERVED
    assert a.has_drift is True
    assert "OWNS" not in a.rel_alias_map()


def test_multi_variant_merges_all_observed_and_flags_confirmation():
    """Same-source multi-variant (has + HAS + Has in ONE graph): the proposed merge maps
    the declared type to ALL observed spellings (reads match every variant immediately)
    and flags needs_confirmation for the Keep/Split decision."""
    a = _align(["has"], ["has", "HAS", "Has"])
    e = a.relationship_entries["has"]
    assert e.kind == MULTI_VARIANT
    assert set(e.observed) == {"has", "HAS", "Has"}
    assert e.needs_confirmation is True
    assert set(a.rel_alias_map()["HAS"]) == {"has", "HAS", "Has"}


def test_explicit_mapping_beats_auto_and_is_not_reconfirmed():
    """A human-confirmed override wins over auto-derivation and is never re-flagged."""
    a = _align(
        ["has"], ["has", "HAS", "Has"],
        explicit_rel={"has": {"observed": ["has"]}},
    )
    e = a.relationship_entries["has"]
    assert e.explicit is True
    assert e.needs_confirmation is False
    assert e.observed == ["has"]


def test_declared_type_in_multiple_lists_aligned_once():
    """A type appearing in both the containment set and the rel-def keys is aligned once."""
    a = _align(["HAS", "HAS", "has"], ["has"])
    # one entry per casefold
    keys = [k.lower() for k in a.relationship_entries]
    assert keys.count("has") == 1


def test_schema_hash_changes_with_observed_schema():
    a1 = _align(["has"], ["has"])
    a2 = _align(["has"], ["has", "to"])
    assert a1.schema_hash != a2.schema_hash
    # stable for the same observed set regardless of declared input
    a3 = _align(["has", "to"], ["has"])
    assert a1.schema_hash == a3.schema_hash


def test_drift_details_shape_for_ui():
    a = _align(["has", "owns"], ["HAS"])
    details = a.drift_details()
    by_declared = {d["declared"]: d for d in details}
    assert by_declared["has"]["kind"] == CASE_VARIANT
    assert by_declared["has"]["observed"] == ["HAS"]
    assert by_declared["owns"]["kind"] == MISSING_OBSERVED
    assert all(d["dimension"] == "relationship" for d in details)


def test_entity_case_variant_aliased():
    a = _align(["has"], ["has"], declared_ent=["dataset"], observed_ent=["Dataset"])
    assert a.entity_entries["dataset"].kind == CASE_VARIANT
    assert a.entity_alias_map() == {"DATASET": ["Dataset"]}


# ── Seed-time canonicalization (bootstrap rows) ───────────────────────────────

def test_canonicalize_rows_rewrites_case_variants_to_declared():
    """Mixed-case source rows in → canonical rows out; the SOURCE spelling is folded to
    the ontology's declared casing so OUR versioned copy is internally consistent."""
    from backend.app.providers.versioned_bootstrap import canonicalize_rows
    from backend.app.services.versioning.ontology import (
        EdgeRule, EntityRule, OntologyRules)

    rules = OntologyRules(
        entity_types={"Dataset": EntityRule()},
        edge_types={"HAS": EdgeRule(is_containment=True)},
        containment_edge_types=frozenset({"HAS"}),
        edge_type_canonical={"HAS": "HAS"},
    )
    rows = [
        {"kind": "node", "id": "n1", "entityType": "dataset"},        # case variant → Dataset
        {"kind": "node", "id": "n2", "entityType": "Dataset"},        # already canonical
        {"kind": "node", "id": "n3", "entityType": "Widget"},         # unknown → untouched
        {"kind": "edge", "id": "e1", "edgeType": "has", "source": "n1", "target": "n2"},  # → HAS
    ]
    changed = canonicalize_rows(rows, rules)
    assert changed == 2  # n1 + e1
    assert rows[0]["entityType"] == "Dataset"
    assert rows[2]["entityType"] == "Widget"      # unknown type passes through
    assert rows[3]["edgeType"] == "HAS"


def test_canonicalize_rows_noop_without_rules():
    from backend.app.providers.versioned_bootstrap import canonicalize_rows
    rows = [{"kind": "edge", "edgeType": "has"}]
    assert canonicalize_rows(rows, None) == 0
    assert rows[0]["edgeType"] == "has"


# ── Provider alias translation ────────────────────────────────────────────────

def test_provider_aliases_containment_set_to_observed_spelling():
    """The provider stores the ontology's (uppercased) containment set but must render
    the source's observed spelling into the case-sensitive Cypher pattern."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(host="x", graph_name="g")
    p.set_containment_edge_types(["has"])              # declared/canonical (stored UPPER)
    p.set_source_type_aliases({"HAS": ["has"]})        # observed spelling for THIS graph
    assert p._get_containment_edge_types() == {"has"}

    # A declared-cased query param is translated too (children path).
    assert set(p._alias_rel_types(["has"])) == {"has"}


def test_provider_identity_without_aliases():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(host="x", graph_name="g")
    p.set_containment_edge_types(["HAS"])
    # No aliases injected (governed/canonical graph) → identity.
    assert p._get_containment_edge_types() == {"HAS"}
    assert p._alias_rel_types(["HAS"]) == ["HAS"]
