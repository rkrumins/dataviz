"""What the model needs to know before it answers: the grounding card.

For a question asked on a view, the card holds:

* the **view** — its name, what it is about, its data source;
* the **schema** — entity types (with how many of each are in scope), which
  edge types are containment and which are lineage;
* the **catalogue** — every property the view's entities carry, how many
  carry it, what kinds of value it holds and (policy allowing) its most
  common values; every tag with its count;
* the **business vocabulary** confirmed for this data source;
* what the person has **selected** or focused on the canvas;
* the **result sets** of earlier answers, which follow-ups may refer to.

All of it comes from the platform's cached reads (``/metadata/schema``,
``/introspection``, ``/search/catalog``), made as the person and naming the
view, so the card never mentions anything they could not see. It is cached per person and view
for a few minutes, and it is bounded: a view with thousands of properties
sends the most-used ones and says how many it left out.

Asked away from any view, the card lists the workspaces and data sources the
person can read instead, and the model uses ``find_views`` to go further.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from ..platform_client import PlatformClient, PlatformError

logger = logging.getLogger(__name__)

_TTL_SECONDS = 300.0
_MAX_PROPERTIES = 60
_MAX_TAGS = 40
_MAX_VALUES = 6
#: A string property with at most this many distinct values keeps them all —
#: enough to read it as "what kind of thing" each entity is (``brief``).
_SMALL_VALUE_SET = 60
#: Placeholder descriptions the platform writes for types nobody described.
_PLACEHOLDER = ("Entity type: ", "Relationship type: ")
#: The platform's own rollup edge: never part of a data source's vocabulary.
_SYSTEM_EDGES = frozenset({"AGGREGATED"})
_cache: dict[tuple, tuple[float, Any]] = {}


def _cached(key: tuple):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _TTL_SECONDS:
        return hit[1]
    return None


def _store(key: tuple, value: Any) -> Any:
    if len(_cache) > 2000:
        _cache.clear()
    _cache[key] = (time.monotonic(), value)
    return value


def clear_cache() -> None:
    _cache.clear()


@dataclass
class Target:
    """Where a question applies: a workspace, a data source, and the view a
    search is bound to (every search is bound to one)."""

    workspace_id: Optional[str] = None
    data_source_id: Optional[str] = None
    view_id: Optional[str] = None
    view_name: Optional[str] = None
    data_source_name: Optional[str] = None
    workspace_name: Optional[str] = None
    #: The person reads this view through a share, not its workspace: the
    #: platform keeps every read inside the view.
    view_only: bool = False

    @property
    def searchable(self) -> bool:
        return bool(self.workspace_id and self.view_id)

    def scope(self, mode: str = "view") -> dict:
        if self.view_only or mode not in ("view", "data_source"):
            mode = "view"
        return {"viewId": self.view_id, "scopeMode": mode}


@dataclass
class Grounding:
    target: Target
    view: Optional[dict] = None
    schema: Optional[dict] = None
    catalog: Optional[dict] = None
    catalog_complete: bool = True
    sources: list[dict] = field(default_factory=list)  # app-wide: workspaces & data sources
    selection: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    #: Whole-data-source counts by entity and edge type (``/introspection``).
    introspection: Optional[dict] = None
    #: The data source's semantic layer (ontology) — its name and id, when readable.
    semantic_layer: Optional[dict] = None
    #: Every value of each low-cardinality string property, with counts.
    value_sets: dict[str, list[dict]] = field(default_factory=dict)
    #: Properties that look like "what kind of thing each entity is" (``brief``).
    type_candidates: list[dict] = field(default_factory=list)
    #: The confirmed one: {"on": "Node", "key": "kind"} (``concepts``).
    type_property: Optional[dict] = None
    #: What a page other than a view is about (workspace, data source, ontology, doc).
    page: Optional[dict] = None

    # ── derived views of the schema, for tools ─────────────────────

    @property
    def entity_types(self) -> list[dict]:
        return list((self.schema or {}).get("entityTypes") or [])

    @property
    def lineage_edge_types(self) -> list[str]:
        return list((self.schema or {}).get("lineageEdgeTypes") or [])

    @property
    def containment_edge_types(self) -> list[str]:
        return list((self.schema or {}).get("containmentEdgeTypes") or [])

    def type_label(self, type_id: str) -> str:
        for et in self.entity_types:
            if et.get("id") == type_id:
                return str(et.get("name") or type_id)
        return type_id

    def type_counts(self) -> dict[str, int]:
        return {
            str(row.get("type")): int(row.get("count") or 0)
            for row in (self.catalog or {}).get("entityTypes") or []
        }

    def properties(self) -> list[dict]:
        return list((self.catalog or {}).get("properties") or [])

    def tags(self) -> list[dict]:
        return list((self.catalog or {}).get("tags") or [])

    def source_counts(self) -> dict[str, int]:
        return {str(r.get("id")): int(r.get("count") or 0)
                for r in (self.introspection or {}).get("entityTypeStats") or []}

    def edge_counts(self) -> dict[str, int]:
        return {str(r.get("id")): int(r.get("count") or 0)
                for r in (self.introspection or {}).get("edgeTypeStats") or []}

    def real_type_ids(self) -> set[str]:
        return {str(t.get("id")) for t in self.entity_types} | set(self.type_counts()) | set(self.source_counts())

    def schema_status(self) -> Optional[str]:
        return ((self.schema or {}).get("_meta") or {}).get("status")

    # ── display types: what kind of thing an entity is ──────────────

    def display_type(self, node: Optional[dict]) -> Optional[str]:
        """*node*'s type as the person thinks of it: its entity type, or —
        when this data source keeps everything under one generic type and the
        person confirmed which property says what kind each one is — that
        property's value."""
        if not isinstance(node, dict):
            return None
        raw = node.get("entityType") or node.get("type")
        tp = self.type_property
        if tp and raw == tp.get("on"):
            value = (node.get("properties") or {}).get(tp.get("key"))
            if isinstance(value, (str, int, float)) and str(value).strip():
                return str(value)
        return raw

    def display_types(self) -> list[dict]:
        """The confirmed type property's values with their counts, or []."""
        tp = self.type_property
        return list(self.value_sets.get(tp["key"]) or []) if tp else []

    def plural(self, type_id: str) -> str:
        for et in self.entity_types:
            if et.get("id") == type_id and et.get("plural"):
                return str(et["plural"])
        word = self.type_label(type_id)
        if word.endswith("s"):
            return word
        return word[:-1] + "ies" if word.endswith("y") and word[-2:-1] not in "aeiou" else word + "s"

    def terminal_types(self) -> Optional[set[str]]:
        """Types lineage ends at — targets of lineage that are never its
        source, from the semantic layer. None when it doesn't say."""
        sources, targets = set(), set()
        for rel in (self.schema or {}).get("relationshipTypes") or []:
            if rel.get("class") == "lineage":
                sources |= set(rel.get("from") or [])
                targets |= set(rel.get("to") or [])
        if not targets:
            return None
        return (targets - sources) or None

    def owner_keys(self, confirmed: Optional[str] = None) -> list[str]:
        """Property keys that record an owner: the confirmed reading of
        "owner" first, then the catalogue's owner-like keys by how many
        entities carry them."""
        from .concepts import tokens_for

        toks = tokens_for("owner")
        found = [p for p in self.properties()
                 if any(t in re.sub(r"[^a-z0-9]", "", str(p.get("key") or "").lower()) for t in toks)]
        found.sort(key=lambda p: -int(p.get("count") or 0))
        keys = ([confirmed] if confirmed else []) + [str(p["key"]) for p in found[:4]]
        return list(dict.fromkeys(k for k in keys if k))

    def adopt(self, fresh: "Grounding") -> None:
        """Work in *fresh*'s view from now on (``set_context``, a default view)."""
        for name in ("target", "view", "schema", "catalog", "catalog_complete", "introspection",
                     "semantic_layer", "value_sets", "type_candidates", "type_property"):
            setattr(self, name, getattr(fresh, name))
        self.sources, self.notes, self.page, self.selection = [], list(fresh.notes), None, []


async def resolve_target(client: PlatformClient, context: dict, *, user_id: str = "",
                         view_only: bool = False) -> Target:
    """The workspace, data source and view the request names. A view says
    which workspace and data source it belongs to; that wins over what the
    request sent, which may be the person's active data source elsewhere."""
    target = Target(
        workspace_id=context.get("workspaceId") or None,
        data_source_id=context.get("dataSourceId") or None,
        view_id=context.get("viewId") or None,
        view_name=context.get("viewName") or None,
        view_only=view_only,
    )
    if target.view_id:
        view = await _view_row(client, user_id, target.view_id)
        if view:
            target.workspace_id = view.get("workspaceId") or target.workspace_id
            target.data_source_id = view.get("dataSourceId") or target.data_source_id
            target.view_name = view.get("name") or target.view_name
            target.data_source_name = view.get("dataSourceName")
            target.workspace_name = view.get("workspaceName")
    return target


async def _view_row(client: PlatformClient, user_id: str, view_id: str) -> Optional[dict]:
    key = ("viewrow", user_id, view_id)
    cached = _cached(key)
    if cached is not None:
        return cached
    try:
        view = await client.get_view(view_id)
    except PlatformError as exc:
        logger.info("grounding: view %s unavailable: %s", view_id, exc)
        return None
    return _store(key, view) if isinstance(view, dict) else None


async def default_view(client: PlatformClient, workspace_id: str, data_source_id: Optional[str]) -> Optional[dict]:
    """A view of the data source the person can read — searches need one to
    be bound to, even when they search the whole data source."""
    try:
        page = await client.list_views(workspace_id=workspace_id, data_source_id=data_source_id,
                                       limit=5, sort="popular")
    except PlatformError:
        return None
    items = (page or {}).get("items") or []
    return items[0] if items else None


def _trim_catalog(catalog: dict, *, include_values: bool) -> dict:
    properties = sorted(catalog.get("properties") or [], key=lambda p: -int(p.get("count") or 0))
    trimmed = []
    for prop in properties[:_MAX_PROPERTIES]:
        row = {
            "key": prop.get("key"), "count": prop.get("count"),
            "kinds": sorted((prop.get("kinds") or {}).keys()),
            "byType": dict(sorted((prop.get("byEntityType") or {}).items(),
                                  key=lambda kv: -kv[1])[:3]),
        }
        if prop.get("min") is not None:
            row["min"], row["max"] = prop.get("min"), prop.get("max")
        if include_values and prop.get("values"):
            row["values"] = [
                {"value": v.get("value"), "count": v.get("count")}
                for v in (prop.get("values") or [])[:_MAX_VALUES]
            ]
        trimmed.append(row)
    tags = sorted(catalog.get("tags") or [], key=lambda t: -int(t.get("count") or 0))[:_MAX_TAGS]
    return {
        "entities": catalog.get("entities"),
        "entityTypes": catalog.get("entityTypes") or [],
        "properties": trimmed,
        "propertiesNotShown": max(0, len(properties) - _MAX_PROPERTIES),
        "tags": tags,
        "tagsNotShown": max(0, len(catalog.get("tags") or []) - _MAX_TAGS),
    }


async def build(client: PlatformClient, *, user_id: str, context: dict,
                include_values: bool = True, view_only: bool = False) -> Grounding:
    target = await resolve_target(client, context, user_id=user_id, view_only=view_only)
    grounding = Grounding(target=target)
    page = context.get("page") if isinstance(context.get("page"), dict) else None

    if target.workspace_id and target.view_id:
        await _ground_view(client, grounding, user_id=user_id, include_values=include_values)
    elif page and page.get("kind") in ("workspace", "data_source", "explorer", "ontology"):
        await _ground_page(client, grounding, user_id=user_id, page=page, context=context,
                           include_values=include_values)
    else:
        grounding.sources = await _sources(client, user_id)
        if page and page.get("kind") == "doc":
            grounding.page = {"kind": "doc", "id": page.get("id"), "title": page.get("title")}

    selected = [u for u in (context.get("selectedUrns") or []) if isinstance(u, str)][:10]
    focus = context.get("focusUrn")
    if isinstance(focus, str) and focus and focus not in selected:
        selected.insert(0, focus)
    if selected and target.workspace_id:
        grounding.selection = await _describe(client, target, selected[:8])
    return grounding


async def _ground_view(client: PlatformClient, grounding: Grounding, *, user_id: str,
                       include_values: bool) -> None:
    target = grounding.target
    key = ("view", user_id, target.view_id, include_values)
    cached = _cached(key)
    if cached is None:
        ws, ds = target.workspace_id, target.data_source_id
        results = await asyncio.gather(
            _view_row(client, user_id, target.view_id),
            client.schema(ws, ds, view_id=target.view_id),
            client.catalog(ws, ds, target.scope("view"), budget_seconds=8),
            client.introspection(ws, ds, view_id=target.view_id),
            _semantic_layer(client, user_id, ws, ds),
            return_exceptions=True,
        )
        view, schema, catalog, introspection, layer = (None if isinstance(r, Exception) else r
                                                       for r in results)
        for name, r in zip(("view", "schema", "catalogue", "counts"), results):
            if isinstance(r, Exception):
                logger.info("grounding: %s unavailable: %s", name, r)
                grounding.notes.append(f"The {name} could not be read: {getattr(r, 'message', r)}")
        from . import brief

        slim_schema = _slim_schema(schema) if schema else None
        cached = {
            "view": _slim_view(view) if view else None,
            "schema": slim_schema,
            "catalog": _trim_catalog(catalog, include_values=include_values) if catalog else None,
            "complete": bool(catalog) and catalog.get("status") == "complete",
            "introspection": _slim_introspection(introspection),
            "layer": layer,
            "valueSets": _value_sets(catalog) if catalog else {},
            "typeCandidates": brief.detect_type_property(catalog, slim_schema, introspection) if catalog else [],
        }
        if (slim_schema and slim_schema.get("entityTypes")) or catalog:
            _store(key, cached)
    grounding.view = cached["view"]
    grounding.schema = cached["schema"]
    grounding.catalog = cached["catalog"]
    grounding.catalog_complete = cached["complete"]
    grounding.introspection = cached["introspection"]
    grounding.semantic_layer = cached["layer"]
    grounding.value_sets = cached["valueSets"]
    grounding.type_candidates = cached["typeCandidates"]
    if not grounding.catalog_complete and grounding.catalog:
        grounding.notes.append("The property catalogue is still being read; counts are partial.")


async def _ground_page(client: PlatformClient, grounding: Grounding, *, user_id: str, page: dict,
                       context: dict, include_values: bool) -> None:
    """A workspace, data source, semantic layer or Explorer page: what it is
    about, and — where a data source is in play — the grounding of one of its
    views, so searches work as they do on a view."""
    kind, page_id = page.get("kind"), str(page.get("id") or "")
    sources = await _sources(client, user_id)
    grounding.sources = sources
    info: dict[str, Any] = {"kind": kind, "id": page_id, "title": page.get("title")}
    through_ws = through_ds = None

    if kind == "workspace":
        ws = next((w for w in sources if w.get("workspaceId") == (page_id or grounding.target.workspace_id)), None)
        if ws:
            info.update(name=ws.get("workspace"), description=ws.get("description"),
                        dataSources=ws.get("dataSources") or [], workspaceId=ws.get("workspaceId"))
    elif kind == "data_source":
        item = await _cached_read(("catalog", user_id, page_id), client.get_catalog_item(page_id)) if page_id else None
        if item:
            info.update(name=item.get("name"), description=item.get("description"),
                        provider=item.get("providerType") or item.get("providerName"))
        for ws in sources:
            for ds in ws.get("dataSources") or []:
                if ds.get("catalogItemId") == page_id and through_ds is None:
                    through_ws, through_ds = ws.get("workspaceId"), ds.get("id")
                    info.setdefault("name", ds.get("name"))
    elif kind == "explorer":
        through_ws = context.get("workspaceId") or grounding.target.workspace_id
        through_ds = context.get("dataSourceId") or grounding.target.data_source_id
        info["name"] = page.get("title") or "Explorer"
    elif kind == "ontology":
        onto = await _cached_read(("ontology", user_id, page_id), client.get_ontology(page_id)) if page_id else None
        if onto:
            info.update(name=onto.get("name"), description=onto.get("description"),
                        version=onto.get("version"), ontology=_slim_ontology(onto))
        info["usedBy"] = [{"workspace": ws.get("workspace"), "dataSource": ds.get("name")}
                          for ws in sources for ds in ws.get("dataSources") or []
                          if page_id and ds.get("ontologyId") == page_id][:20]
    grounding.page = info

    if through_ws:
        view = await default_view(client, through_ws, through_ds)
        if view:
            fresh = await build(client, user_id=user_id, include_values=include_values,
                                context={"viewId": view.get("id"), "workspaceId": through_ws,
                                         "dataSourceId": through_ds})
            grounding.adopt(fresh)
            grounding.sources = sources
            grounding.page = {**info, "seenThrough": {"viewId": view.get("id"), "name": view.get("name")}}
        else:
            grounding.target.workspace_id, grounding.target.data_source_id = through_ws, through_ds


async def _cached_read(key: tuple, call) -> Optional[dict]:
    cached = _cached(key)
    if cached is not None:
        call.close()
        return cached
    try:
        value = await call
    except PlatformError as exc:
        logger.info("grounding: %s unavailable: %s", key[0], exc)
        return None
    return _store(key, value) if isinstance(value, dict) else None


async def _semantic_layer(client: PlatformClient, user_id: str, ws: Optional[str],
                          ds: Optional[str]) -> Optional[dict]:
    """The data source's ontology — its id, and its name where the person
    may read it. ``{"id": None}`` when none is assigned; None when unknown."""
    for entry in await _sources(client, user_id):
        if entry.get("workspaceId") != ws:
            continue
        for source in entry.get("dataSources") or []:
            if source.get("id") == ds:
                onto_id = source.get("ontologyId")
                if not onto_id:
                    return {"id": None, "name": None}
                onto = await _cached_read(("ontology", user_id, onto_id), client.get_ontology(onto_id))
                return {"id": onto_id, "name": (onto or {}).get("name")}
    return None


async def _sources(client: PlatformClient, user_id: str) -> list[dict]:
    key = ("sources", user_id)
    cached = _cached(key)
    if cached is not None:
        return cached
    try:
        workspaces = await client.list_workspaces()
    except PlatformError:
        return []
    items = workspaces.get("items") if isinstance(workspaces, dict) else workspaces
    out = []
    for ws in (items or [])[:20]:
        if not isinstance(ws, dict):
            continue
        entry = {"workspaceId": ws.get("id"), "workspace": ws.get("name"),
                 "description": ws.get("description"), "dataSources": []}
        for ds in (ws.get("dataSources") or [])[:10]:
            if isinstance(ds, dict):
                entry["dataSources"].append({
                    "id": ds.get("id"), "name": ds.get("label") or ds.get("name"),
                    "ontologyId": ds.get("ontologyId"), "catalogItemId": ds.get("catalogItemId"),
                })
        out.append(entry)
    return _store(key, out)


async def _describe(client: PlatformClient, target: Target, urns: list[str]) -> list[dict]:
    async def one(urn: str):
        try:
            node = await client.get_node(target.workspace_id, target.data_source_id, urn,
                                         view_id=target.view_id)
        except PlatformError:
            return None
        return entity_summary(node)

    found = await asyncio.gather(*(one(u) for u in urns))
    return [f for f in found if f]


def entity_summary(node: Optional[dict]) -> Optional[dict]:
    if not isinstance(node, dict) or not node.get("urn"):
        return None
    return {
        "urn": node.get("urn"),
        "name": node.get("displayName") or node.get("urn"),
        "type": node.get("entityType"),
        "description": node.get("description"),
        "tags": node.get("tags") or [],
        "properties": node.get("properties") or {},
    }


def _slim_view(view: dict) -> dict:
    config = view.get("config") if isinstance(view.get("config"), dict) else {}
    content = config.get("content") if isinstance(config.get("content"), dict) else {}
    layout = config.get("layout") if isinstance(config.get("layout"), dict) else {}
    return {
        "id": view.get("id"), "name": view.get("name"), "description": view.get("description"),
        "viewType": view.get("viewType"), "tags": view.get("tags") or [],
        "workspace": view.get("workspaceName"), "dataSource": view.get("dataSourceName"),
        "layout": view.get("layoutType") or layout.get("type") or view.get("viewType"),
        "template": view.get("contextModelName"),
        "owner": view.get("createdByName"), "updatedAt": view.get("updatedAt"),
        "dataUpdatedAt": view.get("dataUpdatedAt"), "visibility": view.get("visibility"),
        "scope": {
            "entityScope": content.get("entityScope"),
            "visibleTypes": [str(t) for t in content.get("visibleEntityTypes") or []][:40],
            "maxDepth": content.get("maxDepth"),
            "roots": len(content.get("rootUrns") or []),
        },
        "layers": _layers(config),
    }


def _layers(config: dict) -> list[dict]:
    """The view's layers in order — ``layout.referenceLayout`` or, in older
    views, ``referenceLayout`` at the top of the config."""
    layout = config.get("layout") if isinstance(config.get("layout"), dict) else {}
    reference = layout.get("referenceLayout") or config.get("referenceLayout") or {}
    layers = [l for l in (reference.get("layers") or []) if isinstance(l, dict)]

    def order(layer: dict) -> float:
        for key in ("order", "sequence"):
            if isinstance(layer.get(key), (int, float)):
                return float(layer[key])
        return 0.0

    return [{"name": str(l.get("name") or l.get("id") or "Layer"),
             "description": l.get("description") or None,
             "types": [str(t) for t in l.get("entityTypes") or []][:20]}
            for l in sorted(layers, key=order)][:30]


def _described(text: Any) -> Optional[str]:
    text = str(text or "").strip()
    return None if not text or text.startswith(_PLACEHOLDER) else text[:500]


def _slim_schema(schema: dict) -> dict:
    entity_types = []
    for et in schema.get("entityTypes") or []:
        hierarchy = et.get("hierarchy") or {}
        contained_by = hierarchy.get("canBeContainedBy") or hierarchy.get("can_be_contained_by") or []
        entity_types.append({
            "id": et.get("id"), "name": et.get("name"), "plural": et.get("pluralName"),
            "description": _described(et.get("description")),
            "level": hierarchy.get("level"),
            "canContain": hierarchy.get("canContain") or hierarchy.get("can_contain") or [],
            "canBeContainedBy": contained_by,
        })
    roots = set(schema.get("rootEntityTypes") or [])
    for et in entity_types:
        et["isRoot"] = et["id"] in roots
    relationships = [
        {"id": rt.get("id"), "name": rt.get("name"),
         "class": "containment" if rt.get("isContainment") else "lineage" if rt.get("isLineage") else "other",
         "category": rt.get("category"), "description": _described(rt.get("description")),
         "from": rt.get("sourceTypes") or [], "to": rt.get("targetTypes") or []}
        for rt in schema.get("relationshipTypes") or []
        if rt.get("id") not in _SYSTEM_EDGES
    ]
    return {
        "entityTypes": entity_types,
        "relationshipTypes": relationships,
        "rootEntityTypes": sorted(roots),
        "containmentEdgeTypes": [e for e in schema.get("containmentEdgeTypes") or [] if e not in _SYSTEM_EDGES],
        "lineageEdgeTypes": [e for e in schema.get("lineageEdgeTypes") or [] if e not in _SYSTEM_EDGES],
        "_meta": {k: v for k, v in (schema.get("_meta") or {}).items() if k in ("status", "source", "updated_at")},
    }


def _slim_introspection(body: Any) -> Optional[dict]:
    """Counts by type for the whole data source. Sample names are left out:
    they reach past the view a person may be reading through a share."""
    if not isinstance(body, dict) or not (body.get("entityTypeStats") or body.get("edgeTypeStats")):
        return None
    return {
        "totalNodes": body.get("totalNodes"), "totalEdges": body.get("totalEdges"),
        "entityTypeStats": [{"id": r.get("id"), "count": r.get("count")}
                            for r in body.get("entityTypeStats") or [] if isinstance(r, dict)],
        "edgeTypeStats": [{"id": r.get("id"), "count": r.get("count")}
                          for r in body.get("edgeTypeStats") or []
                          if isinstance(r, dict) and r.get("id") not in _SYSTEM_EDGES],
    }


def _value_sets(catalog: dict) -> dict[str, list[dict]]:
    out = {}
    for prop in catalog.get("properties") or []:
        kinds = prop.get("kinds") or {}
        if (prop.get("distinctExact") and 0 < int(prop.get("distinct") or 0) <= _SMALL_VALUE_SET
                and "String" in kinds and prop.get("values")):
            out[str(prop.get("key"))] = [{"value": v.get("value"), "count": v.get("count")}
                                         for v in prop["values"][:_SMALL_VALUE_SET]]
    return out


def _slim_ontology(onto: dict) -> dict:
    """An ontology definition, in the schema's shape (types, relationships)."""
    def defs(raw: Any) -> list[tuple[str, dict]]:
        if isinstance(raw, dict):
            return [(str(k), v) for k, v in raw.items() if isinstance(v, dict)]
        return [(str(v.get("id") or v.get("name")), v) for v in raw or [] if isinstance(v, dict)]

    entity_types, relationships = [], []
    for type_id, d in defs(onto.get("entityTypeDefinitions")):
        h = d.get("hierarchy") or {}
        entity_types.append({
            "id": type_id, "name": d.get("name") or type_id, "plural": d.get("pluralName") or d.get("plural_name"),
            "description": _described(d.get("description")), "level": h.get("level"),
            "canContain": h.get("canContain") or h.get("can_contain") or [],
            "canBeContainedBy": h.get("canBeContainedBy") or h.get("can_be_contained_by") or [],
        })
    for rel_id, d in defs(onto.get("relationshipTypeDefinitions")):
        containment = d.get("isContainment", d.get("is_containment"))
        lineage = d.get("isLineage", d.get("is_lineage"))
        relationships.append({
            "id": rel_id, "name": d.get("name") or rel_id,
            "class": "containment" if containment else "lineage" if lineage else "other",
            "category": d.get("category"), "description": _described(d.get("description")),
            "from": d.get("sourceTypes") or d.get("source_types") or [],
            "to": d.get("targetTypes") or d.get("target_types") or [],
        })
    for et in entity_types:
        et["isRoot"] = not et["canBeContainedBy"]
    return {"entityTypes": entity_types, "relationshipTypes": relationships,
            "containmentEdgeTypes": [r["id"] for r in relationships if r["class"] == "containment"],
            "lineageEdgeTypes": [r["id"] for r in relationships if r["class"] == "lineage"]}
