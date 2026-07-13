"""Schema-configurable conversion of generated Solidatus JSON into arbitrary
declared ontologies.

A :class:`ConversionSchema` maps the generator's structural roles (layer/
object/group/attribute for entities, containment/lineage for edges) onto a
declared vocabulary — many-to-one entity collapses are allowed (e.g. object/
group/attribute all → "Node"), multiple edge types per role are assigned
deterministically (containment by parent depth, lineage by transition index),
and ``emit`` lets a payload carry a case variant of the declared spelling
(e.g. emit ``has`` while declaring ``Has``) to exercise the commit-boundary
canonicalizer and per-source alignment.

Presets live in ``backend/scripts/schemas/<name>.json``. The identity preset
(``solidatus_default``) reproduces the legacy ``SolidatusGraphBuilder`` output.

Note: ``bulk_ingest`` does NOT enforce the ontology — seed-time validity comes
structurally from deriving the ontology from the converted graph's observed
pairs, and callers canonicalize rows before ingest (``canonicalize_rows``).
"""
from __future__ import annotations

import json
import logging
import os
import sys
from collections import deque
from dataclasses import dataclass
from typing import Any, Dict, List, Set, Tuple

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.app.ontology.resolver import case_insensitive_type_id_collisions
from backend.common.models.graph import GraphEdge, GraphNode
from backend.scripts.import_solidatus import detect_entity_type_from_prefix, infer_entity_types

logger = logging.getLogger("solidatus_schema")

ROLES = ("layer", "object", "group", "attribute")
SCHEMAS_DIR = os.path.join(os.path.dirname(__file__), "schemas")


@dataclass(frozen=True)
class ConversionSchema:
    """Maps structural roles to a declared vocabulary."""
    name: str
    entity_map: Dict[str, str]   # role → declared entity type (many-to-one OK)
    containment: List[str]       # 1+ declared edge types; containment[parent_depth % len]
    lineage: List[str]           # 1+ declared edge types; lineage[transition_index % len]
    emit: Dict[str, str]         # declared type id → payload spelling (pure case variant)

    def payload_spelling(self, declared: str) -> str:
        return self.emit.get(declared, declared)


def schema_from_dict(spec: Dict[str, Any]) -> ConversionSchema:
    """Validate and build a ConversionSchema from its JSON dict form."""
    entity_types = spec.get("entityTypes") or {}
    missing = [r for r in ROLES if not entity_types.get(r)]
    if missing:
        raise ValueError(f"entityTypes must map all roles {list(ROLES)}; missing: {', '.join(missing)}")
    unknown = [k for k in entity_types if k not in ROLES]
    if unknown:
        raise ValueError(f"entityTypes has unknown roles: {', '.join(unknown)} (expected {list(ROLES)})")

    edge_types = spec.get("edgeTypes") or {}
    containment = list(edge_types.get("containment") or [])
    lineage = list(edge_types.get("lineage") or [])
    if not containment or not all(containment):
        raise ValueError("edgeTypes.containment must be a non-empty list of edge type names")
    if not lineage or not all(lineage):
        raise ValueError("edgeTypes.lineage must be a non-empty list of edge type names")

    declared_entities = list(dict.fromkeys(entity_types.values()))
    declared_edges = list(dict.fromkeys(containment + lineage))

    # Repo-direct ontology creation bypasses the API's authoring guard — run it here.
    collisions = case_insensitive_type_id_collisions(declared_entities, declared_edges)
    if collisions:
        raise ValueError("; ".join(collisions))

    declared_ids = set(declared_entities) | set(declared_edges)
    emit = dict(spec.get("emit") or {})
    for declared, spelling in emit.items():
        if declared not in declared_ids:
            raise ValueError(f"emit key '{declared}' is not a declared type id")
        if str(spelling).lower() != declared.lower():
            raise ValueError(
                f"emit['{declared}'] = '{spelling}' must be a pure case variant of the declared id"
            )

    return ConversionSchema(
        name=spec.get("name") or "unnamed",
        entity_map={r: entity_types[r] for r in ROLES},
        containment=containment,
        lineage=lineage,
        emit=emit,
    )


def load_schema(path_or_name: str) -> ConversionSchema:
    """Load a schema from a JSON file path or a preset name in schemas/."""
    if os.path.isfile(path_or_name):
        path = path_or_name
    else:
        path = os.path.join(SCHEMAS_DIR, f"{path_or_name}.json")
        if not os.path.isfile(path):
            presets = sorted(
                f[:-5] for f in os.listdir(SCHEMAS_DIR) if f.endswith(".json")
            ) if os.path.isdir(SCHEMAS_DIR) else []
            raise ValueError(
                f"Schema '{path_or_name}' is neither a file nor a preset. Presets: {presets}"
            )
    with open(path, "r") as f:
        return schema_from_dict(json.load(f))


IDENTITY_SCHEMA = load_schema("solidatus_default")


@dataclass
class ConvertedGraph:
    """Conversion output: payload-ready nodes/edges plus the DECLARED-casing
    observations the ontology derivation needs."""
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    containment_pairs: Set[Tuple[str, str, str]]  # (parent_type, child_type, edge_type)
    lineage_pairs: Set[Tuple[str, str, str]]      # (source_type, target_type, edge_type)
    root_types: Set[str]
    type_levels: Dict[str, int]                   # declared type → min observed depth


def convert_model(
    data: Dict[str, Any],
    schema: ConversionSchema,
    source_system: str = "solidatus",
) -> ConvertedGraph:
    """Convert a generated Solidatus model dict under the given schema."""
    entities: Dict[str, Any] = data.get("entities", {})
    root_ids: List[str] = data.get("layers", []) or data.get("roots", [])
    transitions: Dict[str, Any] = data.get("transitions", {})

    role_map = infer_entity_types(entities, root_ids)

    # Depth from roots over children — drives multi-containment-type assignment.
    depth: Dict[str, int] = {rid: 0 for rid in root_ids if rid in entities}
    queue = deque(depth)
    while queue:
        eid = queue.popleft()
        for kid in entities.get(eid, {}).get("children", []) or []:
            if kid in entities and kid not in depth:
                depth[kid] = depth[eid] + 1
                queue.append(kid)

    nodes: List[GraphNode] = []
    edges: List[GraphEdge] = []
    declared_of: Dict[str, str] = {}
    urn_of: Dict[str, str] = {}
    root_id_set = set(root_ids)

    def _add_node(eid: str, declared: str, name: str, props: Dict[str, Any]) -> None:
        declared_of[eid] = declared
        urn = f"urn:synodic:{source_system}:{declared.lower()}:{eid}"
        urn_of[eid] = urn
        nodes.append(GraphNode(
            urn=urn,
            entityType=schema.payload_spelling(declared),
            displayName=name,
            qualifiedName=name,
            properties=props,
            tags=[],
        ))

    for eid, edef in entities.items():
        role = role_map.get(eid, "object")
        props = dict(edef.get("properties", {}))
        props["solidatusId"] = eid
        if eid in root_id_set:
            props["isLayer"] = True
        _add_node(eid, schema.entity_map[role], edef.get("name", eid), props)

    containment_pairs: Set[Tuple[str, str, str]] = set()
    lineage_pairs: Set[Tuple[str, str, str]] = set()

    for eid, edef in entities.items():
        children = edef.get("children", []) or []
        if not children:
            continue
        edge_type = schema.containment[depth.get(eid, 0) % len(schema.containment)]
        for kid in children:
            if kid not in entities:
                logger.warning("Child %s referenced by %s not found in entities — skipping", kid, eid)
                continue
            edges.append(GraphEdge(
                id=f"{edge_type.lower()}-{urn_of[eid]}-{urn_of[kid]}",
                sourceUrn=urn_of[eid],
                targetUrn=urn_of[kid],
                edgeType=schema.payload_spelling(edge_type),
                properties={},
            ))
            containment_pairs.add((declared_of[eid], declared_of[kid], edge_type))

    for index, (tid, tdef) in enumerate(transitions.items()):
        source_id, target_id = tdef.get("source"), tdef.get("target")
        if not source_id or not target_id:
            logger.warning("Transition %s missing source/target — skipping", tid)
            continue
        # Placeholder nodes for external references (parity with the legacy importer).
        for ref_id in (source_id, target_id):
            if ref_id not in declared_of:
                role = detect_entity_type_from_prefix(ref_id) or "attribute"
                logger.info("Creating placeholder node for external reference %s", ref_id)
                _add_node(ref_id, schema.entity_map[role], ref_id,
                          {"solidatusId": ref_id, "placeholder": True})
        edge_type = schema.lineage[index % len(schema.lineage)]
        props = dict(tdef.get("properties", {}))
        props["solidatusTransitionId"] = tid
        edges.append(GraphEdge(
            id=f"{edge_type.lower()}-{urn_of[source_id]}-{urn_of[target_id]}",
            sourceUrn=urn_of[source_id],
            targetUrn=urn_of[target_id],
            edgeType=schema.payload_spelling(edge_type),
            properties=props,
        ))
        lineage_pairs.add((declared_of[source_id], declared_of[target_id], edge_type))

    root_types = {declared_of[rid] for rid in root_ids if rid in declared_of}
    type_levels: Dict[str, int] = {}
    for eid, d in depth.items():
        declared = declared_of[eid]
        type_levels[declared] = min(type_levels.get(declared, d), d)
    return ConvertedGraph(
        nodes=nodes,
        edges=edges,
        containment_pairs=containment_pairs,
        lineage_pairs=lineage_pairs,
        root_types=root_types,
        type_levels=type_levels,
    )


def to_ingest_rows(cg: ConvertedGraph) -> List[dict]:
    """Bulk-ingest rows in the exact ``collect_provider_rows`` shape (nodes first)."""
    rows: List[dict] = []
    for n in cg.nodes:
        payload = n.model_dump(by_alias=True, exclude_none=True)
        rows.append({"kind": "node", "id": n.urn, **payload})
    for e in cg.edges:
        rows.append({
            "kind": "edge", "id": e.id, "edgeType": e.edge_type,
            "source": e.source_urn, "target": e.target_urn,
            **(e.properties or {}),
        })
    return rows


def derive_ontology_request(cg_schema: ConversionSchema, cg: ConvertedGraph, *, name: str,
                            description: str = None):
    """Build an OntologyCreateRequest from the schema's declared vocabulary and the
    converted graph's OBSERVED pairs, so the derived ontology always admits the data
    it was derived from. Root types = declared entity types with an empty derived
    ``can_be_contained_by`` (mirrors ``derive_flat_lists``)."""
    from backend.common.models.management import OntologyCreateRequest

    declared_entities = list(dict.fromkeys(cg_schema.entity_map[r] for r in ROLES))
    children_of: Dict[str, Set[str]] = {t: set() for t in declared_entities}
    parents_of: Dict[str, Set[str]] = {t: set() for t in declared_entities}
    for parent, child, _ in cg.containment_pairs:
        children_of[parent].add(child)
        parents_of[child].add(parent)

    entity_defs = {
        t: {
            "name": t,
            "plural_name": f"{t}s",
            "hierarchy": {
                "level": cg.type_levels.get(t, 0),
                "can_contain": sorted(children_of[t]),
                "can_be_contained_by": sorted(parents_of[t]),
            },
        }
        for t in declared_entities
    }

    all_pairs = cg.containment_pairs | cg.lineage_pairs
    rel_defs = {}
    for et in dict.fromkeys(cg_schema.containment + cg_schema.lineage):
        is_containment = et in cg_schema.containment
        rel_defs[et] = {
            "name": et,
            "category": "structural" if is_containment else "flow",
            "is_containment": is_containment,
            "is_lineage": et in cg_schema.lineage,
            "source_types": sorted({p for p, _, e in all_pairs if e == et}),
            "target_types": sorted({c for _, c, e in all_pairs if e == et}),
        }

    return OntologyCreateRequest(
        name=name,
        description=description or f"Derived from Solidatus conversion schema '{cg_schema.name}'",
        containment_edge_types=list(cg_schema.containment),
        lineage_edge_types=list(cg_schema.lineage),
        root_entity_types=[t for t in declared_entities if not parents_of[t]],
        entity_type_definitions=entity_defs,
        relationship_type_definitions=rel_defs,
    )


# ── Versioned-service ingest (needs the management + graphver DBs) ────────────

async def register_ontology(session, schema: ConversionSchema, cg: ConvertedGraph, *, name: str) -> str:
    """Create + publish the ontology derived from ``schema``/``cg``; return its id."""
    from backend.app.db.repositories import ontology_definition_repo

    req = derive_ontology_request(schema, cg, name=name)
    created = await ontology_definition_repo.create_ontology(session, req)
    await ontology_definition_repo.publish_ontology(session, created.id)
    return created.id


async def ingest_versioned(
    *,
    schema: ConversionSchema,
    cg: ConvertedGraph,
    workspace_id: str,
    provider_id: str,
    graph_name: str,
    actor: str = "import_solidatus",
    ontology_name: str = None,
    ontology_id: str = None,
    project: bool = True,
) -> Dict[str, Any]:
    """Ingest a converted graph through the versioned service: register the derived
    ontology (unless ``ontology_id`` reuses one), provision a manual data source +
    strict versioned graph pinned to it, canonicalize the rows to the declared casing,
    bulk-ingest one ``import`` commit, and (default) project to FalkorDB.

    The workspace and provider rows must already exist (created by the CLI's dev stack
    or the test helper's ``seed_workspace_provider``). Mirrors the blank-graph endpoint:
    the data source commits before ``create_graph`` (management and graphver may be
    separate DBs — no 2PC)."""
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.repositories import data_source_repo
    from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
    from backend.app.ontology.rules import resolved_ontology_to_rules
    from backend.app.ontology.service import LocalOntologyService
    from backend.app.providers.versioned_bootstrap import canonicalize_rows
    from backend.app.services.versioning import models as gv_models
    from backend.app.services.versioning.service import GraphVersioningService
    from backend.common.models.management import DataSourceCreateRequest

    await gv_models.create_schema_and_partitions()  # idempotent
    svc = GraphVersioningService()
    Session = get_session_factory(PoolRole.WEB)

    async with Session() as s:
        if ontology_id is None:
            ontology_id = await register_ontology(
                s, schema, cg, name=ontology_name or f"Solidatus {schema.name}")
        ds = await data_source_repo.create_data_source(s, workspace_id, DataSourceCreateRequest(
            provider_id=provider_id, ontology_id=ontology_id, graph_name=graph_name,
            label=graph_name, access_level="write"))
        row = await data_source_repo.get_data_source_orm(s, ds.id)
        row.source_mode = "managed"
        await s.commit()
        ds_id = ds.id

    created = await svc.create_graph(
        data_source_id=ds_id, workspace_id=workspace_id, kind="manual", actor=actor,
        base_ontology_id=ontology_id, falkor_graph_name=graph_name,
        falkor_provider=provider_id, ontology_enforcement="strict")
    graph_id = created["graph_id"]

    async with Session() as s:
        resolved = await LocalOntologyService(SQLAlchemyOntologyRepository(s)).resolve(
            workspace_id=workspace_id, data_source_id=ds_id)
    rules = resolved_ontology_to_rules(resolved)

    rows = to_ingest_rows(cg)
    canonicalized = canonicalize_rows(rows, rules)
    report = await svc.bulk_ingest(
        graph_id=graph_id, rows=rows, actor=actor,
        idempotency_key=f"solidatus:{graph_name}:{schema.name}")

    if project:
        from backend.app.services.versioning.projection import (
            FalkorProjector, make_falkor_graph_factory,
        )
        await FalkorProjector(graph_client_factory=make_falkor_graph_factory()).project_graph(graph_id)

    return {
        "ontology_id": ontology_id,
        "data_source_id": ds_id,
        "graph_id": graph_id,
        "main_branch_id": created["main_branch_id"],
        "canonicalized": canonicalized,
        "ingested": report.get("ingested"),
        "rejected": report.get("rejected", []),
        "rules": rules,
        "graph_name": graph_name,
    }
