"""A starter graph: what a new Playground graph is made with in one request.

Two front doors make one — a sample (``playground_samples``) and a person's own data
(``POST /playground/graphs``) — and both describe it the same way, as a :class:`Starter`:

* its **data model**: the entity and relationship types it uses, each relationship joining the
  types its rows join with it (:func:`ontology_row`). A relationship marked ``containment`` is a
  structural one (its source contains its target), the rest are lineage;
* its **things and connections**: the rows of a day-0 import, loaded as the graph's first version
  (a sample's; a graph for a person's own data has none, and loads its file through the import);
* its **views**: a Context View (one layer per top-level type, in the starter's order), a Graph
  view, and — when it has a containment — a Hierarchy view of the container and what it holds;
* its **library and details** (saved queries and display rules on the Context View; the data
  source's tags and links) and an **example change** waiting for review — a sample's.

The route that makes one (``endpoints/playground.py``) puts these together; nothing here writes
except :func:`ensure_ontology`.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OntologyORM
from backend.app.ontology.resolver import (
    derive_flat_lists, parse_entity_definitions, parse_relationship_definitions,
    sync_hierarchy_from_relationships,
)


@dataclass(frozen=True)
class EntityType:
    name: str
    plural: str
    description: str
    icon: str
    color: str


@dataclass(frozen=True)
class RelationshipType:
    name: str
    description: str
    color: str
    #: Structural: its source contains its target (a Hierarchy view's tree), not lineage.
    containment: bool = False


@dataclass(frozen=True)
class SavedQuery:
    #: Unique in the starter; the query's id is the Context View's id and this.
    slug: str
    name: str
    description: str
    predicate: dict


@dataclass(frozen=True)
class Example:
    """One change waiting for review: a new thing, connected from one already there."""
    title: str
    description: str
    #: The new thing, as a node row of :attr:`Starter.rows`.
    node: dict
    #: The urn of the thing it is connected from, and by which relationship.
    source: str
    relationship: str


@dataclass(frozen=True)
class Starter:
    title: str
    description: Optional[str]
    #: A lucide icon name, for its views.
    icon: str
    ontology_id: str
    ontology_name: str
    ontology_description: str
    #: In the order the Context View lays them out; a contained type follows its container.
    entity_types: Dict[str, EntityType]
    relationship_types: Dict[str, RelationshipType]
    #: The fields every type has.
    fields: Tuple[dict, ...]
    #: Its day-0 import: nodes named by urn, edges by the urns at their ends.
    rows: Tuple[dict, ...]
    #: The first version's message.
    message: str
    #: The Context View's name; the others are named after the starter.
    view_name: str
    #: On its views and its data source.
    tags: Tuple[str, ...] = ()
    #: ``(label, path)``: links on its data source, to pages of this site.
    links: Tuple[Tuple[str, str], ...] = ()
    queries: Tuple[SavedQuery, ...] = ()
    #: Display rules on the Context View, as ``view_library.put_rule`` takes them.
    rules: Tuple[dict, ...] = ()
    example: Optional[Example] = None

    def containment(self) -> Optional[Tuple[str, str, str]]:
        """``(relationship, container type, contained type)`` of its containment, or None."""
        types = _endpoint_types(self)
        for rid, rel in self.relationship_types.items():
            if rel.containment and types[rid][0] and types[rid][1]:
                return rid, types[rid][0][0], types[rid][1][0]
        return None

    def top_level_types(self) -> List[str]:
        """Its types that nothing contains: the Context View's layers, the Graph view's types."""
        held = {child for rid, rel in self.relationship_types.items() if rel.containment
                for child in _endpoint_types(self)[rid][1]}
        return [t for t in self.entity_types if t not in held]


def _endpoint_types(starter: Starter) -> Dict[str, Tuple[List[str], List[str]]]:
    """Each relationship's source and target types, as its rows join them (sorted)."""
    type_of = {row["urn"]: row["entityType"] for row in starter.rows if row["kind"] == "node"}
    ends: Dict[str, Tuple[set, set]] = {rid: (set(), set()) for rid in starter.relationship_types}
    for row in starter.rows:
        if row["kind"] == "edge":
            ends[row["edgeType"]][0].add(type_of[row["source"]])
            ends[row["edgeType"]][1].add(type_of[row["target"]])
    return {rid: (sorted(s), sorted(t)) for rid, (s, t) in ends.items()}


def _words(name: str) -> List[str]:
    return re.findall(r"[A-Za-z0-9]+", unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode())


def _entity_type_id(name: str, taken: set) -> str:
    """A type's id from its name, as the types the platform ships are named (``warehouseTable``)."""
    words = _words(name)
    base = (words[0].lower() + "".join(w[:1].upper() + w[1:] for w in words[1:])) if words else "type"
    return _unique(base if base[0].isalpha() else f"t{base}", taken, "")


def _relationship_type_id(name: str, taken: set) -> str:
    """A relationship's id from its name, as the platform's are (``LOADS_INTO``)."""
    base = "_".join(w.upper() for w in _words(name)) or "LINKED_TO"
    return _unique(base if base[0].isalpha() else f"R_{base}", taken, "_")


def _unique(base: str, taken: set, sep: str) -> str:
    out, n = base, 1
    while out in taken:
        n += 1
        out = f"{base}{sep}{n}"
    taken.add(out)
    return out


def raw_entity(t: EntityType, fields: Tuple[dict, ...]) -> dict:
    """An entity type as a data model stores it, before it is parsed."""
    return {"name": t.name, "plural_name": t.plural, "description": t.description,
            "visual": {"icon": t.icon, "color": t.color}, "fields": [dict(f) for f in fields]}


def raw_relationship(r: RelationshipType, sources: List[str], targets: List[str]) -> dict:
    """A relationship as a data model stores it, before it is parsed: lineage is ``flow``, a
    containment ``structural``."""
    return {"name": r.name, "description": r.description,
            "category": "structural" if r.containment else "flow",
            "is_containment": r.containment, "is_lineage": not r.containment,
            "visual": {"stroke_color": r.color}, "source_types": sources, "target_types": targets}


def definition_columns(raw_entities: Dict[str, dict], raw_relationships: Dict[str, dict]) -> dict:
    """A data model's type columns, as ``ontologies`` holds them: the types parsed, each contained
    type's hierarchy saying what may contain it, and the flat lists derived from them."""
    entities = parse_entity_definitions(sync_hierarchy_from_relationships(raw_entities, raw_relationships))
    relationships = parse_relationship_definitions(raw_relationships)
    flat = derive_flat_lists(entities, relationships)
    return {
        "entity_type_definitions": json.dumps({k: asdict(v) for k, v in entities.items()}),
        "relationship_type_definitions": json.dumps({k: asdict(v) for k, v in relationships.items()}),
        "containment_edge_types": json.dumps(flat.containment_edge_types),
        "lineage_edge_types": json.dumps(flat.lineage_edge_types),
        "edge_type_metadata": json.dumps(flat.edge_type_metadata),
        "entity_type_hierarchy": json.dumps(flat.entity_type_hierarchy),
        "root_entity_types": json.dumps(flat.root_entity_types),
    }


def ontology_row(starter: Starter) -> OntologyORM:
    """Its data model as a published data model, not yet added. Lineage relationships are
    ``flow``; a containment is ``structural``, and the contained type's hierarchy says what may
    contain it — so it is no top-level type. Not ``is_system``: the platform finds *the* system
    default data model as the ``is_system`` one with the highest version
    (``ontology_definition_repo.get_system_default_ontology``), so another would be taken for it."""
    ends = _endpoint_types(starter)
    columns = definition_columns(
        {tid: raw_entity(t, starter.fields) for tid, t in starter.entity_types.items()},
        {rid: raw_relationship(r, ends[rid][0], ends[rid][1]) for rid, r in starter.relationship_types.items()},
    )
    return OntologyORM(
        id=starter.ontology_id, schema_id=starter.ontology_id, version=1,
        name=starter.ontology_name, description=starter.ontology_description, **columns,
        is_published=True, published_at=datetime.now(timezone.utc).isoformat(),
        scope="universal",
    )


async def ensure_ontology(session: AsyncSession, starter: Starter) -> str:
    """Its data model, published, made the first time it is asked for and the same one every time
    after. Returns its id. Whatever is at its id is used as it is: an administrator who withdrew
    it (unpublished, deleted) is answered as a blank graph on it would be.

    Commits — and, when someone else made it a moment ago, rolls back: the caller reads nothing
    from ORM rows it loaded before."""
    if await session.get(OntologyORM, starter.ontology_id) is not None:
        return starter.ontology_id
    session.add(ontology_row(starter))
    try:
        await session.commit()
    except IntegrityError:
        # Someone else started it first, a moment ago: theirs is the one.
        await session.rollback()
    return starter.ontology_id


# ── Its views ─────────────────────────────────────────────────────────────
# Configured as the View wizard configures each layout (``buildViewConfig`` in
# ``frontend/src/services/viewService.ts``).

_FILTERS = {"entityTypeFilters": [], "fieldFilters": [], "searchableFields": [], "quickFilters": []}


def _config(starter: Starter, layout: dict, types: List[str], relationships: List[str]) -> dict:
    return {
        "icon": starter.icon,
        "content": {"visibleEntityTypes": types, "visibleRelationshipTypes": relationships,
                    "defaultDepth": 5, "maxDepth": 10},
        "layout": {**layout, "lod": {"enabled": False, "levels": []}},
        "filters": dict(_FILTERS),
        "entityOverrides": {},
    }


def context_view_config(starter: Starter) -> dict:
    """One layer per top-level type, in the starter's order (the wizard's "one layer per type"):
    each places the things of its type, and a contained thing is shown inside its container."""
    layers = [
        {"id": f"layer_{tid}", "name": starter.entity_types[tid].plural, "description": "",
         "color": starter.entity_types[tid].color, "icon": starter.entity_types[tid].icon,
         "entityTypes": [tid], "order": i, "sequence": i}
        for i, tid in enumerate(starter.top_level_types())
    ]
    return _config(starter, {"type": "reference", "referenceLayout": {"layers": layers, "assignments": {}}},
                   list(starter.entity_types), list(starter.relationship_types))


def graph_view_config(starter: Starter) -> dict:
    """The lineage between its top-level things, left to right."""
    return _config(starter, {"type": "graph", "graphLayout": {"algorithm": "dagre", "direction": "LR",
                                                              "nodeSpacing": 60, "levelSpacing": 120}},
                   starter.top_level_types(),
                   [rid for rid, r in starter.relationship_types.items() if not r.containment])


def hierarchy_view_config(starter: Starter) -> dict:
    """Its containers and what they hold. Only for a starter with a containment."""
    rid, container, child = starter.containment()
    return _config(starter, {"type": "hierarchy"}, [container, child], [rid])


def views(starter: Starter) -> List[Tuple[str, str, str, dict]]:
    """``(key, view type, name, config)`` of each view it is made with, the Context View first."""
    out = [("context", "reference", starter.view_name, context_view_config(starter)),
           ("graph", "graph", f"{starter.title}: lineage graph", graph_view_config(starter))]
    held = starter.containment()
    if held:
        container, child = starter.entity_types[held[1]], starter.entity_types[held[2]]
        out.append(("hierarchy", "hierarchy", f"{starter.title}: {container.plural} and their "
                    f"{child.plural.lower()}", hierarchy_view_config(starter)))
    return out
