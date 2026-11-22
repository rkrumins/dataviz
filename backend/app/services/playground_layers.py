"""Semantic layers in the Playground: which ones a member may build on, and their own.

A member builds on an approved org-wide layer (published, ``scope="universal"``, not a system
layer), a starter, a sample's, one of their own, or one another member shared with the Playground.
Their own layers are owned by the Playground (``owner_workspace_id``) and made by them
(``created_by``): they edit and publish those whatever the org's semantic-layer switches say.

The contract the rest of the Playground builds on (``scratchpad/byod-layers/CONTRACT.md``):
:func:`offered_ontology_ids`, :func:`assert_offered`, :func:`starter_types_of`,
:func:`create_owned` and :func:`drop_owned`. And the owner rule (:func:`owns_layer`), what a
member sees (:func:`visible_ontology_ids`), the models on offer (:func:`models`) and the types a
file adds to a layer of one's own (:func:`with_types`).

* **Own layers** start private (``owner_visibility="private"``) and ``scope="workspace"``. Sharing
  one with the Playground (``"workspace"``) lets other members see it and build on it once it is
  published; only its maker changes it.
* **Who owns one.** Every version of an owned layer keeps its maker as ``created_by``
  (``ontology_definition_repo._owner_of``), so the owner rule holds across versions.
* **A quota.** ``layerQuota`` live layers per person (``playground_policy``): 409 ``layer_quota``.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OntologyAuditLogORM, OntologyORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.ontology.resolver import parse_entity_definitions, parse_relationship_definitions
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.playground_policy import (
    PLAYGROUND_FLAG, get_playground, is_owner_or_admin, settings_of,
)
from backend.app.services.playground_starter import (
    EntityType, RelationshipType, _entity_type_id, _relationship_type_id, definition_columns,
    raw_entity, raw_relationship,
)

logger = logging.getLogger(__name__)

PRIVATE, SHARED = "private", "workspace"
#: The order ``GET /playground/models`` lists them in.
KINDS = ("approved", "starter", "sample", "yours", "shared")
#: Building in the Playground: what its members hold.
_MEMBER = "workspace:datasource:manage"
_SAMPLE = "bp_sample_"
#: The first Bring your own data made a model per graph from one person's file: never on offer.
_PER_GRAPH = "bp_import_"
#: What a file's types make: at most this many of each, named in at most this many characters.
TYPES_MAX = 50
NAME_MAX = 60

_COLORS = ("#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316",
           "#64748b", "#84cc16")
_FIELDS = (
    {"id": "name", "name": "Name", "type": "string", "show_in_tooltip": True, "display_order": 1},
    {"id": "description", "name": "Description", "type": "markdown", "show_in_node": False, "display_order": 2},
)


def _refuse(code: int, kind: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message, **extra})


async def playground_on(session: AsyncSession) -> bool:
    """Whether ``playgroundEnabled`` is on (off when it can't be read)."""
    from backend.app.config.feature_wiring import fail_safe_default
    from backend.app.services.feature_flags import feature_flags
    return await feature_flags.is_enabled(PLAYGROUND_FLAG, session, default=fail_safe_default(PLAYGROUND_FLAG))


def is_member(claims: PermissionClaims, ws: WorkspaceORM) -> bool:
    """Whether the caller builds in the Playground: they manage its data sources."""
    return has_permission(claims, _MEMBER, workspace_id=ws.id)


def _schema(row) -> str:
    return getattr(row, "schema_id", None) or row.id


# ── Which layers ─────────────────────────────────────────────────────────

def _approved():
    """Approved for everyone: an org layer, published, org-wide, not the system's."""
    return and_(OntologyORM.is_published.is_(True), OntologyORM.deleted_at.is_(None),
                OntologyORM.is_system.is_(False), OntologyORM.scope == "universal",
                OntologyORM.owner_workspace_id.is_(None), ~OntologyORM.id.startswith(_PER_GRAPH))


def _own(ws_id: str, user_id: str):
    return and_(OntologyORM.owner_workspace_id == ws_id, OntologyORM.created_by == user_id)


def _shared(ws_id: str):
    return and_(OntologyORM.owner_workspace_id == ws_id, OntologyORM.owner_visibility == SHARED,
                OntologyORM.is_published.is_(True), OntologyORM.deleted_at.is_(None))


async def visible_ontology_ids(session: AsyncSession, claims: PermissionClaims,
                               user_id: Optional[str]) -> Set[str]:
    """What a Playground member sees beyond the layers their workspaces' data sources use:
    approved org-wide layers, their own (in any state, so a deleted one can be restored), those
    shared with the Playground, and — for its admin — every layer it owns. Another member's
    private layer stays hidden (unless a graph the reader can read is built on it). Nothing for
    anyone not in the Playground."""
    ws = await get_playground(session)
    if ws is None or not claims.ws_perms.get(ws.id):
        return set()
    clauses = [_approved(), _shared(ws.id)]
    if user_id:
        clauses.append(_own(ws.id, user_id))
    if has_permission(claims, "workspace:admin", workspace_id=ws.id):
        clauses.append(OntologyORM.owner_workspace_id == ws.id)
    return set((await session.execute(select(OntologyORM.id).where(or_(*clauses)))).scalars())


async def _offered_rows(session: AsyncSession, ws: WorkspaceORM, user_id: Optional[str]) -> List[OntologyORM]:
    from backend.app.services.playground_samples import SAMPLES
    picked = [*settings_of(ws).starter_ontology_ids, *(s.ontology_id for s in SAMPLES)]
    clauses = [_approved(), _shared(ws.id), OntologyORM.id.in_(picked)]
    if user_id:
        clauses.append(_own(ws.id, user_id))
    return list((await session.execute(
        select(OntologyORM).where(OntologyORM.deleted_at.is_(None), or_(*clauses))
    )).scalars())


async def offered_ontology_ids(session: AsyncSession, claims: PermissionClaims,
                               user_id: Optional[str]) -> Set[str]:
    """The layers ``user_id`` may build a Playground graph on: approved org-wide layers, the
    starters, the samples' models, their own, and those shared with the Playground. Empty for
    anyone who isn't a member."""
    ws = await get_playground(session)
    if ws is None or not is_member(claims, ws):
        return set()
    return {row.id for row in await _offered_rows(session, ws, user_id)}


async def assert_offered(session: AsyncSession, claims: PermissionClaims, user_id: Optional[str],
                         ontology_id: str) -> OntologyORM:
    """The layer, when the caller may build on it here — else 404 ``unknown_ontology`` (missing or
    deleted), 403 ``ontology_not_offered``, 422 ``ontology_not_published`` (one of their own still
    in draft, say). Not on offer is asked before published, so nobody learns the state of a layer
    they can't see."""
    row = await session.get(OntologyORM, ontology_id)
    if row is None or row.deleted_at:
        raise _refuse(status.HTTP_404_NOT_FOUND, "unknown_ontology", "There is no such semantic layer.")
    if ontology_id not in await offered_ontology_ids(session, claims, user_id):
        raise _refuse(status.HTTP_403_FORBIDDEN, "ontology_not_offered",
                      "That semantic layer isn't one you can build on in the Playground.")
    if not row.is_published:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "ontology_not_published",
                      "Publish the semantic layer first: a graph is built on a published one.")
    return row


def kind_of(row, ws_id: str, user_id: Optional[str], starters: Sequence[str]) -> str:
    """How the models list labels a layer on offer (one label, the most personal first)."""
    if row.owner_workspace_id == ws_id:
        return "yours" if user_id and row.created_by == user_id else "shared"
    if row.id in starters:
        return "starter"
    if row.id.startswith(_SAMPLE):
        return "sample"
    return "approved"


async def models(session: AsyncSession, claims: PermissionClaims, user_id: str) -> List[dict]:
    """``GET /playground/models``: the newest version of each layer on offer, with its kind, its
    types and how many of the caller's live Playground graphs use any version of it — sorted by
    kind (:data:`KINDS`) and then name."""
    ws = await get_playground(session)
    if ws is None or not is_member(claims, ws):
        return []
    newest: Dict[str, OntologyORM] = {}
    for row in await _offered_rows(session, ws, user_id):
        held = newest.get(_schema(row))
        if held is None or row.version > held.version:
            newest[_schema(row)] = row
    used = Counter(schema or oid for oid, schema in (await session.execute(
        select(WorkspaceDataSourceORM.ontology_id, OntologyORM.schema_id)
        .join(OntologyORM, OntologyORM.id == WorkspaceDataSourceORM.ontology_id)
        .where(WorkspaceDataSourceORM.workspace_id == ws.id, WorkspaceDataSourceORM.created_by == user_id,
               WorkspaceDataSourceORM.deleted_at.is_(None))
    )).all())
    starters = settings_of(ws).starter_ontology_ids
    out = [{
        "id": row.id, "name": row.name, "description": row.description, "version": row.version,
        "kind": kind_of(row, ws.id, user_id, starters), "is_published": bool(row.is_published),
        "shared": row.owner_visibility == SHARED,
        "entity_type_count": len(json.loads(row.entity_type_definitions or "{}")),
        "relationship_type_count": len(json.loads(row.relationship_type_definitions or "{}")),
        "used_by": used.get(schema, 0),
    } for schema, row in newest.items()]
    return sorted(out, key=lambda m: (KINDS.index(m["kind"]), m["name"].casefold()))


async def newest_offered(session: AsyncSession, claims: PermissionClaims, user_id: str) -> List[OntologyORM]:
    """The rows :func:`models` lists: the newest version of each layer on offer."""
    ids = {m["id"] for m in await models(session, claims, user_id)}
    if not ids:
        return []
    return list((await session.execute(select(OntologyORM).where(OntologyORM.id.in_(ids)))).scalars())


# ── A starter graph's types ──────────────────────────────────────────────

async def starter_types_of(session: AsyncSession, ontology_id: str,
                           used_entity_types: Optional[Sequence[str]] = None,
                           ) -> Tuple[Dict[str, EntityType], Dict[str, RelationshipType]]:
    """A layer's entity and relationship types as a starter graph's views read them (name,
    plural, icon, colour; a relationship's containment), keyed by type id — limited to
    ``used_entity_types`` (and the relationships among them) when given, in the layer's order."""
    row = await session.get(OntologyORM, ontology_id)
    if row is None:
        return {}, {}
    used = None if used_entity_types is None else set(used_entity_types)
    entities = {
        tid: EntityType(d.name or tid, d.plural_name or d.name or tid, d.description or "",
                        d.visual.icon, d.visual.color)
        for tid, d in parse_entity_definitions(json.loads(row.entity_type_definitions or "{}")).items()
        if used is None or tid in used
    }
    contained = {str(t).upper() for t in json.loads(row.containment_edge_types or "[]")}

    def among(types: List[str]) -> bool:              # none named: it joins any type
        return not types or bool(set(types) & set(entities))

    relationships = {
        rid: RelationshipType(d.name or rid, d.description or "", d.visual.stroke_color,
                              containment=bool(d.is_containment or rid.upper() in contained))
        for rid, d in parse_relationship_definitions(json.loads(row.relationship_type_definitions or "{}")).items()
        if used is None or (among(d.source_types) and among(d.target_types))
    }
    return entities, relationships


# ── The owner rule ───────────────────────────────────────────────────────

async def owns_layer(session: AsyncSession, claims: PermissionClaims, user_id: Optional[str], row,
                     *, playground: Optional[WorkspaceORM] = None) -> bool:
    """Whether the caller changes ``row`` (a layer, or its response) as its maker, whatever the
    semantic-layer switches say: a person, never an API key; a member of the Playground while
    ``playgroundEnabled`` is on; the layer is the Playground's, and they made it — or they are a
    Playground or platform admin."""
    if row is None or claims.key_scope is not None or not user_id or not getattr(row, "owner_workspace_id", None):
        return False
    ws = playground or await get_playground(session)
    if ws is None or row.owner_workspace_id != ws.id or not is_member(claims, ws):
        return False
    if not await playground_on(session):
        return False
    return is_owner_or_admin(ws.id, row.created_by, user_id, claims)


async def held_by_playground(session: AsyncSession, row) -> bool:
    """Whether ``row`` is a layer the Playground owns."""
    owner = getattr(row, "owner_workspace_id", None)
    if not owner:
        return False
    ws = await get_playground(session)
    return ws is not None and owner == ws.id


# ── Layers of one's own ──────────────────────────────────────────────────

class InferredConnection(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=NAME_MAX)
    ends: List[Tuple[str, str]] = Field(default_factory=list, max_length=500)


class InferredModel(BaseModel):
    """A data model made from a file's types: thing types, and connection types with the type
    pairs their rows join (by name)."""
    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)

    thing_types: List[str] = Field(default_factory=list, alias="thingTypes")
    connection_types: List[InferredConnection] = Field(default_factory=list, alias="connectionTypes")


async def layers_made_by(session: AsyncSession, ws_id: str, user_id: str) -> int:
    """The live layers of their own ``user_id`` has in the workspace — what ``layerQuota`` counts:
    a layer, not each of its versions."""
    return (await session.execute(
        select(func.count(func.distinct(OntologyORM.schema_id))).where(
            OntologyORM.owner_workspace_id == ws_id, OntologyORM.created_by == user_id,
            OntologyORM.deleted_at.is_(None))
    )).scalar_one() or 0


def _inferred(raw: Any) -> InferredModel:
    try:
        model = InferredModel.model_validate(raw)
    except ValidationError as exc:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_rows",
                      "The file's types can't make a semantic layer: " + exc.errors()[0]["msg"])
    for section, items in (("thingTypes", model.thing_types), ("connectionTypes", model.connection_types)):
        if len(items) > TYPES_MAX:
            raise _refuse(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "too_large",
                          f"A semantic layer made from a file has at most {TYPES_MAX} types of each kind; "
                          f"this one has {len(items)}.", section=section, limit=TYPES_MAX)
    if any(not 1 <= len(name) <= NAME_MAX for name in model.thing_types):
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_rows",
                      f"A type's name is 1 to {NAME_MAX} characters.")
    return model


def _entity_def(name: str, i: int) -> dict:
    return raw_entity(EntityType(name, name, f"{name}, as the file names them.", "Box",
                                 _COLORS[i % len(_COLORS)]), _FIELDS)


def _relationship_def(name: str, i: int, sources: List[str], targets: List[str]) -> dict:
    return raw_relationship(RelationshipType(name, f"{name}, as the file names it.",
                                             _COLORS[i % len(_COLORS)]), sources, targets)


def _from_inferred(model: InferredModel) -> dict:
    """A layer's type columns from a file's types: an entity type per thing type and a lineage
    relationship per connection type, each joining the types its rows join."""
    taken: set = set()
    entity_ids = {name: _entity_type_id(name, taken) for name in dict.fromkeys(model.thing_types)}
    rel_taken: set = set()
    raw_relationships = {}
    for i, link in enumerate(model.connection_types):
        ends = [(entity_ids[a], entity_ids[b]) for a, b in link.ends if a in entity_ids and b in entity_ids]
        raw_relationships[_relationship_type_id(link.name, rel_taken)] = _relationship_def(
            link.name, i, sorted({a for a, _ in ends}), sorted({b for _, b in ends}))
    return definition_columns({tid: _entity_def(name, i) for i, (name, tid) in enumerate(entity_ids.items())},
                              raw_relationships)


async def _create_request(session: AsyncSession, claims: PermissionClaims, user_id: str, name: str,
                          description: Optional[str], source: Mapping[str, Any]):
    """The new layer as ``POST /admin/ontologies`` would take it, from ``source`` — or 422
    ``invalid_source``; 404 for a layer to copy that the caller can't see."""
    from backend.common.models.management import OntologyCreateRequest, OntologyImportRequest

    starts = [k for k in ("blank", "cloneOf", "layer", "infer") if k in source]
    if len(starts) != 1:
        raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_source",
                      "Start a semantic layer from one thing: blank, a copy of a layer, a layer file "
                      "or your file's types.")
    start = starts[0]
    if start == "blank":
        return OntologyCreateRequest(name=name, description=description)
    if start == "cloneOf":
        from backend.app.services.workspace_visibility import ensure_ontology_visible
        original = await session.get(OntologyORM, str(source["cloneOf"]))
        if original is None or original.deleted_at:
            raise _refuse(status.HTTP_404_NOT_FOUND, "unknown_ontology", "There is no such semantic layer.")
        await ensure_ontology_visible(session, claims, original.id, user_id=user_id)
        return OntologyCreateRequest(
            name=name, description=description if description is not None else original.description,
            evolutionPolicy=original.evolution_policy or "reject",
            containmentEdgeTypes=json.loads(original.containment_edge_types or "[]"),
            lineageEdgeTypes=json.loads(original.lineage_edge_types or "[]"),
            edgeTypeMetadata=json.loads(original.edge_type_metadata or "{}"),
            entityTypeHierarchy=json.loads(original.entity_type_hierarchy or "{}"),
            rootEntityTypes=json.loads(original.root_entity_types or "[]"),
            entityTypeDefinitions=json.loads(original.entity_type_definitions or "{}"),
            relationshipTypeDefinitions=json.loads(original.relationship_type_definitions or "{}"),
        )
    if start == "layer":
        # The same checks a Semantic Layers import makes (``POST /admin/ontologies/import``).
        from backend.app.api.v1.endpoints.ontologies import normalise_layer_body
        export = source["layer"] if isinstance(source["layer"], dict) else {}
        try:
            req = OntologyImportRequest.model_validate({
                **export, "name": name,
                "description": description if description is not None else export.get("description")})
        except ValidationError as exc:
            raise _refuse(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_layer",
                          "That isn't a Semantic Layers file: " + exc.errors()[0]["msg"])
        normalise_layer_body(req)
        return OntologyCreateRequest(
            name=req.name, description=req.description, evolutionPolicy=req.evolution_policy,
            containmentEdgeTypes=req.containment_edge_types, lineageEdgeTypes=req.lineage_edge_types,
            edgeTypeMetadata=req.edge_type_metadata, entityTypeHierarchy=req.entity_type_hierarchy,
            rootEntityTypes=req.root_entity_types, entityTypeDefinitions=req.entity_type_definitions,
            relationshipTypeDefinitions=req.relationship_type_definitions,
        )
    columns = _from_inferred(_inferred(source["infer"]))
    return OntologyCreateRequest(
        name=name, description=description,
        containmentEdgeTypes=json.loads(columns["containment_edge_types"]),
        lineageEdgeTypes=json.loads(columns["lineage_edge_types"]),
        edgeTypeMetadata=json.loads(columns["edge_type_metadata"]),
        entityTypeHierarchy=json.loads(columns["entity_type_hierarchy"]),
        rootEntityTypes=json.loads(columns["root_entity_types"]),
        entityTypeDefinitions=json.loads(columns["entity_type_definitions"]),
        relationshipTypeDefinitions=json.loads(columns["relationship_type_definitions"]),
    )


async def create_owned(session: AsyncSession, *, claims: PermissionClaims, user_id: str,
                       playground_id: str, name: str, description: Optional[str],
                       source: Mapping[str, Any], publish: bool) -> OntologyORM:
    """A semantic layer of the caller's own in the Playground, from ``source``: ``{"blank": True}``,
    ``{"cloneOf": id}`` (a layer they can see), ``{"layer": <Semantic Layers export>}`` or
    ``{"infer": {"thingTypes": [...], "connectionTypes": [{"name", "ends"}]}}``. Owned by the
    Playground and made by ``user_id``; published when ``publish``. 409 ``layer_quota`` past the
    member's quota. Committed."""
    from backend.app.db.repositories import ontology_definition_repo

    ws = await session.get(WorkspaceORM, playground_id)
    quota = settings_of(ws).layer_quota if ws is not None else 0
    if await layers_made_by(session, playground_id, user_id) >= quota:
        raise _refuse(status.HTTP_409_CONFLICT, "layer_quota",
                      f"You have {quota} semantic layers in the Playground, its limit. "
                      "Delete one to make another.", limit=quota)
    req = await _create_request(session, claims, user_id, name, description, source)
    made = await ontology_definition_repo.create_ontology(session, req, actor=user_id)
    row = await session.get(OntologyORM, made.id)
    row.scope = "workspace"
    row.owner_workspace_id = playground_id
    row.owner_visibility = PRIVATE
    await session.flush()
    if publish:
        await ontology_definition_repo.publish_ontology(session, row.id, actor=user_id)
    await session.commit()
    return row


async def drop_owned(session: AsyncSession, ontology_id: str) -> None:
    """Remove a layer of one's own that nothing was built on (a failed start's): the layer and its
    history. One a live data source uses, or an org layer, is left as it is. Never raises."""
    try:
        row = await session.get(OntologyORM, ontology_id)
        if row is None or not row.owner_workspace_id:
            return
        used = (await session.execute(select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.ontology_id == ontology_id,
            WorkspaceDataSourceORM.deleted_at.is_(None)).limit(1))).first()
        if used is not None:
            logger.warning("semantic layer %s is in use; not removed", ontology_id)
            return
        await session.execute(delete(OntologyAuditLogORM).where(OntologyAuditLogORM.ontology_id == ontology_id))
        await session.execute(delete(OntologyORM).where(OntologyORM.id == ontology_id))
        await session.commit()
    except Exception:
        logger.exception("could not remove semantic layer %s — left unused", ontology_id)
        await session.rollback()


async def share(session: AsyncSession, row: OntologyORM, shared: bool, actor: str) -> None:
    """Share a layer of one's own with the Playground, or make it private again — every version of
    it. Graphs already built on it keep it: their data sources keep it visible to their makers."""
    from sqlalchemy import update
    from backend.app.db.repositories.ontology_definition_repo import lineage_of
    await session.execute(
        update(OntologyORM).where(lineage_of(row), OntologyORM.owner_workspace_id == row.owner_workspace_id)
        .values(owner_visibility=SHARED if shared else PRIVATE, updated_by=actor)
        .execution_options(synchronize_session="fetch"))
    await session.flush()


# ── Adding a file's types to a layer of one's own ────────────────────────

def _casefold_index(defs: Dict[str, dict]) -> Dict[str, str]:
    """Each type's id by its id and by its name, case-folded: how a file's names find a type."""
    index: Dict[str, str] = {}
    for tid, d in defs.items():
        index.setdefault(tid.casefold(), tid)
        name = (d or {}).get("name") if isinstance(d, dict) else None
        if name:
            index.setdefault(str(name).casefold(), tid)
    return index


def _ends_key(d: dict, snake: str, camel: str) -> str:
    return camel if camel in d and snake not in d else snake


def with_types(row: OntologyORM, entity_names: Sequence[str],
               relationships: Sequence[Tuple[str, Sequence[Tuple[str, str]]]],
               ) -> Tuple[Dict[str, dict], Dict[str, dict], Dict[str, str], Dict[str, str], bool]:
    """``row``'s type definitions with a file's types added: an entity type per name it doesn't
    have, a lineage relationship per relationship name it doesn't have, joining the types named at
    its ends (by id, then name). A name it has already is found, not added — and a relationship
    that names the types it joins gains the ends it lacks. Returns the definitions, each name's
    type id, and whether anything changed."""
    entities: Dict[str, dict] = json.loads(row.entity_type_definitions or "{}")
    rels: Dict[str, dict] = json.loads(row.relationship_type_definitions or "{}")
    changed = False
    index = _casefold_index(entities)
    entity_ids: Dict[str, str] = {}
    taken = set(entities)
    for name in dict.fromkeys(n.strip() for n in entity_names if n.strip()):
        # By its id or name — or by the id it would be given (``Loads into`` is ``LOADS_INTO``).
        tid = index.get(name.casefold()) or index.get(_entity_type_id(name, set()).casefold())
        if tid is None:
            tid = _entity_type_id(name, taken)
            parsed = definition_columns({tid: _entity_def(name, len(entities))}, {})
            entities[tid] = json.loads(parsed["entity_type_definitions"])[tid]
            index[name.casefold()] = index[tid.casefold()] = tid
            changed = True
        entity_ids[name] = tid
    rel_index = _casefold_index(rels)
    rel_ids: Dict[str, str] = {}
    rel_taken = set(rels)
    for name, ends in relationships:
        name = name.strip()
        if not name:
            continue
        pairs = [(index[a.casefold()], index[b.casefold()]) for a, b in ends
                 if a.casefold() in index and b.casefold() in index]
        rid = rel_index.get(name.casefold()) or rel_index.get(_relationship_type_id(name, set()).casefold())
        if rid is None:
            rid = _relationship_type_id(name, rel_taken)
            parsed = definition_columns({}, {rid: _relationship_def(
                name, len(rels), sorted({a for a, _ in pairs}), sorted({b for _, b in pairs}))})
            rels[rid] = json.loads(parsed["relationship_type_definitions"])[rid]
            rel_index[name.casefold()] = rel_index[rid.casefold()] = rid
            changed = True
        else:
            d = rels[rid]
            for snake, camel, wanted in (("source_types", "sourceTypes", {a for a, _ in pairs}),
                                         ("target_types", "targetTypes", {b for _, b in pairs})):
                key = _ends_key(d, snake, camel)
                have = list(d.get(key) or [])
                if have and not wanted <= set(have):          # none named: it joins any type already
                    d[key] = have + sorted(wanted - set(have))
                    changed = True
        rel_ids[name] = rid
    return entities, rels, entity_ids, rel_ids, changed


async def move_graphs(session: AsyncSession, *, ws_id: str, user_id: str, from_id: str, to_id: str) -> int:
    """Move the caller's live Playground data sources on ``from_id`` to ``to_id`` — and their
    forks with them, whose layer is their parent's. Returns how many of the caller's moved."""
    from backend.app.services import fork_sources
    rows = list((await session.execute(select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.workspace_id == ws_id, WorkspaceDataSourceORM.created_by == user_id,
        WorkspaceDataSourceORM.ontology_id == from_id, WorkspaceDataSourceORM.deleted_at.is_(None),
        WorkspaceDataSourceORM.fork_of_data_source_id.is_(None),
    ))).scalars())
    now = datetime.now(timezone.utc).isoformat()
    for ds in rows:
        before = fork_sources.governing(ds)
        ds.ontology_id = to_id
        ds.updated_at = now
        await fork_sources.follow_parent(session, ds, before)
    await session.flush()
    return len(rows)
