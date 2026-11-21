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

All of it comes from the platform's cached, view-scoped reads
(``/metadata/schema``, ``/search/catalog``), made as the person, so the card
never mentions anything they could not see. It is cached per person and view
for a few minutes, and it is bounded: a view with thousands of properties
sends the most-used ones and says how many it left out.

Asked away from any view, the card lists the workspaces and data sources the
person can read instead, and the model uses ``find_views`` to go further.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from ..platform_client import PlatformClient, PlatformError

logger = logging.getLogger(__name__)

_TTL_SECONDS = 300.0
_MAX_PROPERTIES = 60
_MAX_TAGS = 40
_MAX_VALUES = 6
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

    @property
    def searchable(self) -> bool:
        return bool(self.workspace_id and self.view_id)

    def scope(self, mode: str = "view") -> dict:
        return {"viewId": self.view_id, "scopeMode": mode if mode in ("view", "data_source") else "view"}


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


async def resolve_target(client: PlatformClient, context: dict) -> Target:
    """The workspace, data source and view the request names, filled in from
    the view when only it is named."""
    target = Target(
        workspace_id=context.get("workspaceId") or None,
        data_source_id=context.get("dataSourceId") or None,
        view_id=context.get("viewId") or None,
        view_name=context.get("viewName") or None,
    )
    if target.view_id and not (target.workspace_id and target.data_source_id and target.view_name):
        try:
            view = await client.get_view(target.view_id)
        except PlatformError:
            view = None
        if view:
            target.workspace_id = target.workspace_id or view.get("workspaceId")
            target.data_source_id = target.data_source_id or view.get("dataSourceId")
            target.view_name = target.view_name or view.get("name")
            target.data_source_name = view.get("dataSourceName")
            target.workspace_name = view.get("workspaceName")
    return target


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
                include_values: bool = True) -> Grounding:
    target = await resolve_target(client, context)
    grounding = Grounding(target=target)

    if target.workspace_id and target.view_id:
        key = ("view", user_id, target.view_id, include_values)
        cached = _cached(key)
        if cached is None:
            view_t = asyncio.create_task(client.get_view(target.view_id))
            schema_t = asyncio.create_task(client.schema(target.workspace_id, target.data_source_id))
            catalog_t = asyncio.create_task(client.catalog(
                target.workspace_id, target.data_source_id, target.scope("view"), budget_seconds=8,
            ))
            results = await asyncio.gather(view_t, schema_t, catalog_t, return_exceptions=True)
            view, schema, catalog = (None if isinstance(r, Exception) else r for r in results)
            for name, r in zip(("view", "schema", "catalogue"), results):
                if isinstance(r, Exception):
                    logger.info("grounding: %s unavailable: %s", name, r)
                    grounding.notes.append(f"The {name} could not be read: {getattr(r, 'message', r)}")
            cached = {
                "view": _slim_view(view) if view else None,
                "schema": _slim_schema(schema) if schema else None,
                "catalog": _trim_catalog(catalog, include_values=include_values) if catalog else None,
                "complete": bool(catalog) and catalog.get("status") == "complete",
            }
            if schema or catalog:
                _store(key, cached)
        grounding.view = cached["view"]
        grounding.schema = cached["schema"]
        grounding.catalog = cached["catalog"]
        grounding.catalog_complete = cached["complete"]
        if not grounding.catalog_complete and grounding.catalog:
            grounding.notes.append("The property catalogue is still being read; counts are partial.")
    else:
        grounding.sources = await _sources(client, user_id)

    selected = [u for u in (context.get("selectedUrns") or []) if isinstance(u, str)][:10]
    focus = context.get("focusUrn")
    if isinstance(focus, str) and focus and focus not in selected:
        selected.insert(0, focus)
    if selected and target.workspace_id:
        grounding.selection = await _describe(client, target, selected[:8])
    return grounding


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
        entry = {"workspaceId": ws.get("id"), "workspace": ws.get("name"), "dataSources": []}
        for ds in (ws.get("dataSources") or [])[:10]:
            if isinstance(ds, dict):
                entry["dataSources"].append({"id": ds.get("id"), "name": ds.get("label") or ds.get("name")})
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
    return {
        "id": view.get("id"), "name": view.get("name"), "description": view.get("description"),
        "viewType": view.get("viewType"), "tags": view.get("tags") or [],
        "workspace": view.get("workspaceName"), "dataSource": view.get("dataSourceName"),
    }


def _slim_schema(schema: dict) -> dict:
    entity_types = []
    for et in schema.get("entityTypes") or []:
        hierarchy = et.get("hierarchy") or {}
        entity_types.append({
            "id": et.get("id"), "name": et.get("name"), "plural": et.get("pluralName"),
            "level": hierarchy.get("level"),
            "canContain": hierarchy.get("canContain") or hierarchy.get("can_contain") or [],
        })
    relationships = [
        {"id": rt.get("id"), "name": rt.get("name"),
         "class": "containment" if rt.get("isContainment") else "lineage" if rt.get("isLineage") else "other",
         "from": rt.get("sourceTypes") or [], "to": rt.get("targetTypes") or []}
        for rt in schema.get("relationshipTypes") or []
    ]
    return {
        "entityTypes": entity_types,
        "relationshipTypes": relationships,
        "rootEntityTypes": schema.get("rootEntityTypes") or [],
        "containmentEdgeTypes": schema.get("containmentEdgeTypes") or [],
        "lineageEdgeTypes": schema.get("lineageEdgeTypes") or [],
    }
