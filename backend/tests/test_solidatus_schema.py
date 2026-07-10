"""Unit tests for backend/scripts/solidatus_schema.py — the schema-configurable
Solidatus→ontology conversion seam.

A ConversionSchema maps the generator's structural roles (layer/object/group/
attribute + containment/lineage) onto arbitrary declared vocabularies. The
identity preset must reproduce the legacy SolidatusGraphBuilder output; the
roots_node preset is the canonical many-to-one collapse (Roots/Node + Has/
Flows_To with a lowercase `has` emit variant).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.scripts.generate_solidatus_model import SolidatusModelGenerator
from backend.scripts.import_solidatus import SolidatusGraphBuilder
from backend.scripts.solidatus_schema import (
    IDENTITY_SCHEMA,
    convert_model,
    load_schema,
    schema_from_dict,
)


def _model(seed=42, num_layers=3, **kw):
    return SolidatusModelGenerator(num_layers=num_layers, seed=seed, **kw).generate()


def _base_spec(**overrides):
    spec = {
        "name": "t",
        "entityTypes": {"layer": "L", "object": "O", "group": "G", "attribute": "A"},
        "edgeTypes": {"containment": ["HAS"], "lineage": ["FLOWS_TO"]},
    }
    spec.update(overrides)
    return spec


# ── Schema loading / validation ─────────────────────────────────────────────

def test_load_preset_roots_node():
    s = load_schema("roots_node")
    assert s.entity_map == {"layer": "Roots", "object": "Node", "group": "Node", "attribute": "Node"}
    assert s.containment == ["Has"]
    assert s.lineage == ["Flows_To"]
    assert s.emit == {"Has": "has"}


def test_missing_role_raises():
    spec = _base_spec()
    del spec["entityTypes"]["group"]
    with pytest.raises(ValueError, match="group"):
        schema_from_dict(spec)


def test_empty_containment_raises():
    with pytest.raises(ValueError, match="containment"):
        schema_from_dict(_base_spec(edgeTypes={"containment": [], "lineage": ["FLOWS_TO"]}))


def test_non_case_variant_emit_raises():
    with pytest.raises(ValueError, match="case variant"):
        schema_from_dict(_base_spec(emit={"HAS": "Owns"}))


def test_emit_key_not_declared_raises():
    with pytest.raises(ValueError, match="declared"):
        schema_from_dict(_base_spec(emit={"CONTAINS": "contains"}))


def test_case_colliding_declared_edge_ids_raise():
    with pytest.raises(ValueError, match="case"):
        schema_from_dict(_base_spec(edgeTypes={"containment": ["HAS"], "lineage": ["has"]}))


# ── Conversion ───────────────────────────────────────────────────────────────

def test_identity_schema_matches_legacy_builder():
    model = _model()
    legacy = SolidatusGraphBuilder()
    legacy.build(model)
    cg = convert_model(model, IDENTITY_SCHEMA)
    assert {(n.urn, n.entity_type) for n in cg.nodes} \
        == {(n.urn, n.entity_type) for n in legacy.nodes}
    assert {(e.source_urn, e.target_urn, e.edge_type) for e in cg.edges} \
        == {(e.source_urn, e.target_urn, e.edge_type) for e in legacy.edges}


def test_roots_node_conversion_maps_types_and_emit_casing():
    model = _model()
    assert model["transitions"], "seed must produce lineage for this test"
    cg = convert_model(model, load_schema("roots_node"))

    # Node payloads: many-to-one collapse, layers → Roots, everything else → Node
    assert {n.entity_type for n in cg.nodes} == {"Roots", "Node"}
    layer_ids = set(model["layers"])
    for n in cg.nodes:
        expected = "Roots" if n.properties.get("solidatusId") in layer_ids else "Node"
        assert n.entity_type == expected

    # Edge payloads carry the EMITTED spelling (has), lineage the declared one
    assert {e.edge_type for e in cg.edges} == {"has", "Flows_To"}

    # Derivation surfaces keep DECLARED casing
    assert cg.root_types == {"Roots"}
    assert ("Roots", "Node", "Has") in cg.containment_pairs
    assert ("Node", "Node", "Has") in cg.containment_pairs
    assert all(et == "Has" for _, _, et in cg.containment_pairs)
    assert cg.lineage_pairs and all(et == "Flows_To" for _, _, et in cg.lineage_pairs)


# ── Ontology derivation ──────────────────────────────────────────────────────

def _derived(schema_name="roots_node", model=None):
    from backend.scripts.solidatus_schema import derive_ontology_request
    model = model or _model()
    schema = load_schema(schema_name)
    cg = convert_model(model, schema)
    return schema, cg, derive_ontology_request(schema, cg, name="Test Ontology")


def test_derive_ontology_roots_node():
    from backend.app.ontology.resolver import parse_entity_definitions, parse_relationship_definitions

    _, _, req = _derived()
    assert req.name == "Test Ontology"

    ents = parse_entity_definitions(req.entity_type_definitions)
    assert set(ents) == {"Roots", "Node"}
    assert ents["Roots"].hierarchy.can_contain == ["Node"]
    assert ents["Node"].hierarchy.can_contain == ["Node"]  # self-nesting from the collapse
    assert ents["Roots"].hierarchy.can_be_contained_by == []
    assert ents["Node"].hierarchy.can_be_contained_by == ["Node", "Roots"]
    assert ents["Roots"].hierarchy.level == 0
    assert ents["Node"].hierarchy.level == 1  # min observed depth

    rels = parse_relationship_definitions(req.relationship_type_definitions)
    assert set(rels) == {"Has", "Flows_To"}
    assert rels["Has"].is_containment and not rels["Has"].is_lineage
    assert rels["Flows_To"].is_lineage and not rels["Flows_To"].is_containment
    assert rels["Has"].source_types == ["Node", "Roots"]
    assert rels["Has"].target_types == ["Node"]
    assert rels["Flows_To"].source_types == ["Node"]
    assert rels["Flows_To"].target_types == ["Node"]

    assert req.containment_edge_types == ["Has"]
    assert req.lineage_edge_types == ["Flows_To"]
    assert req.root_entity_types == ["Roots"]


# ── Ingest rows ──────────────────────────────────────────────────────────────

def test_to_ingest_rows_shape_and_order():
    from backend.scripts.solidatus_schema import to_ingest_rows

    model = _model()
    cg = convert_model(model, load_schema("roots_node"))
    rows = to_ingest_rows(cg)

    kinds = [r["kind"] for r in rows]
    assert kinds == ["node"] * len(cg.nodes) + ["edge"] * len(cg.edges)

    node_row = rows[0]
    assert node_row["id"] == node_row["urn"]
    assert set(node_row) >= {"kind", "id", "urn", "entityType", "displayName", "qualifiedName", "properties", "tags"}

    edge_row = rows[len(cg.nodes)]
    assert set(edge_row) >= {"kind", "id", "edgeType", "source", "target"}
    edge_props = {k for r in rows[len(cg.nodes):] for k in r}
    assert "solidatusTransitionId" in edge_props  # edge properties are flattened into the row


def test_conversion_is_deterministic():
    import json as _json
    from backend.scripts.solidatus_schema import to_ingest_rows

    model = _model()
    a = _json.dumps(to_ingest_rows(convert_model(model, load_schema("multi_containment"))), sort_keys=True)
    b = _json.dumps(to_ingest_rows(convert_model(model, load_schema("multi_containment"))), sort_keys=True)
    assert a == b


# ── Multi-containment preset ─────────────────────────────────────────────────

def test_multi_containment_assigns_edge_type_by_parent_depth():
    model = _model(groups_chance=1.0)  # force the Group tier so depths 0/1/2 all parent
    schema = load_schema("multi_containment")
    assert schema.containment == ["Groups", "Holds"]
    cg = convert_model(model, schema)

    # Emit variant on the attribute type only
    assert {n.entity_type for n in cg.nodes} == {"Zone", "Asset", "field"}

    # containment[parent_depth % 2]: layers (0) → Groups, objects (1) → Holds, groups (2) → Groups
    id_of = lambda urn: urn.rsplit(":", 1)[1]
    layer_ids = set(model["layers"])
    for e in cg.edges:
        if e.edge_type == "Feeds":
            continue
        parent_id = id_of(e.source_urn)
        if parent_id in layer_ids:
            assert e.edge_type == "Groups"
        elif parent_id.startswith("OBJ-"):
            assert e.edge_type == "Holds"
        else:
            assert parent_id.startswith("GRP-")
            assert e.edge_type == "Groups"

    assert {et for _, _, et in cg.containment_pairs} == {"Groups", "Holds"}


# ── Derived ontology must admit its own data ─────────────────────────────────

@pytest.mark.parametrize("preset", ["solidatus_default", "roots_node", "multi_containment"])
def test_derived_ontology_admits_its_own_rows(preset):
    from types import SimpleNamespace

    from backend.app.ontology.resolver import parse_entity_definitions, parse_relationship_definitions
    from backend.app.ontology.rules import resolved_ontology_to_rules
    from backend.app.services.versioning.ontology import validate_entities_rich
    from backend.scripts.solidatus_schema import derive_ontology_request, to_ingest_rows

    model = _model(groups_chance=1.0)
    schema = load_schema(preset)
    cg = convert_model(model, schema)
    req = derive_ontology_request(schema, cg, name="t")
    rows = to_ingest_rows(cg)

    rules = resolved_ontology_to_rules(SimpleNamespace(
        entity_type_definitions=parse_entity_definitions(req.entity_type_definitions),
        relationship_type_definitions=parse_relationship_definitions(req.relationship_type_definitions),
        containment_edge_types=req.containment_edge_types,
        lineage_edge_types=req.lineage_edge_types,
    ))

    endpoint_types = {r["id"]: r["entityType"] for r in rows if r["kind"] == "node"}
    entities = [
        (r["id"], r["kind"],
         {"entityType": r.get("entityType")} if r["kind"] == "node"
         else {"edgeType": r.get("edgeType"), "sourceEntityId": r["source"], "targetEntityId": r["target"]},
         "create")
        for r in rows
    ]
    assert validate_entities_rich(entities, endpoint_types, rules) == []


def test_canonicalize_rows_restores_declared_casing():
    from types import SimpleNamespace

    from backend.app.ontology.resolver import parse_entity_definitions, parse_relationship_definitions
    from backend.app.ontology.rules import resolved_ontology_to_rules
    from backend.app.providers.versioned_bootstrap import canonicalize_rows
    from backend.scripts.solidatus_schema import derive_ontology_request, to_ingest_rows

    model = _model()
    schema = load_schema("roots_node")
    cg = convert_model(model, schema)
    req = derive_ontology_request(schema, cg, name="t")
    rows = to_ingest_rows(cg)
    assert any(r.get("edgeType") == "has" for r in rows)  # emitted variant present pre-canonicalization

    rules = resolved_ontology_to_rules(SimpleNamespace(
        entity_type_definitions=parse_entity_definitions(req.entity_type_definitions),
        relationship_type_definitions=parse_relationship_definitions(req.relationship_type_definitions),
        containment_edge_types=req.containment_edge_types,
        lineage_edge_types=req.lineage_edge_types,
    ))
    changed = canonicalize_rows(rows, rules)
    assert changed > 0
    edge_types = {r["edgeType"] for r in rows if r["kind"] == "edge"}
    assert edge_types == {"Has", "Flows_To"}


# ── Converter handles the generator's structural knobs ──────────────────────

def test_flat_depth2_yields_layer_to_attribute_containment():
    model = _model(depth=2)
    cg = convert_model(model, load_schema("roots_node"))
    # Every containment pair is Roots→Node (layer directly holds attributes)
    assert cg.containment_pairs
    assert all(pair == ("Roots", "Node", "Has") for pair in cg.containment_pairs)


def test_orphans_are_nodes_with_no_containment_pair():
    model = _model(orphans=4)
    cg = convert_model(model, load_schema("roots_node"))

    layer_ids = set(model["layers"])
    contained = {kid for e in model["entities"].values() for kid in e.get("children", [])}
    orphan_ids = set(model["entities"]) - contained - layer_ids
    assert len(orphan_ids) == 4

    orphan_urns = {n.urn for n in cg.nodes if n.properties.get("solidatusId") in orphan_ids}
    assert len(orphan_urns) == 4
    # An orphan is never the child endpoint of a containment edge
    child_urns = {e.target_urn for e in cg.edges if e.edge_type in ("has", "Has")}
    assert orphan_urns.isdisjoint(child_urns)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
