"""What the assistant knows about where the person is — as a card for them,
and as a compact section of the model's CONTEXT.

One grounding (``grounding.py``) feeds both:

* :func:`for_ui` — everything the person can read about the view or page:
  what it is, its layers, the semantic layer's types and how they nest, every
  kind of connection with its direction and count, what properties and tags
  its entities carry, and anything that limits the answers (``caveats``).
  It is shown on request ("what do you know about this view?") and in the
  panel's context card; the data-sharing policy does not cut it, because the
  person could read all of it anyway.
* :func:`for_model` — the same structure, ranked and bounded, with
  descriptions under ``description`` keys and sample values under ``values``
  keys so ``policy.DataPolicy`` strips them when an administrator says so.

It also reads a data source's *shape*: a data source that keeps everything
under one generic type (``Node``) usually says what kind each entity is in a
property (``kind = table``). :func:`detect_type_property` finds candidates;
the person confirms one (``concepts``), and from then on "tables" means
``Node`` whose ``kind`` is ``table``.
"""
from __future__ import annotations

import copy
import re
from typing import Any, Optional

#: Type names that say nothing about what a thing is.
_GENERIC_TYPE = re.compile(
    r"^(node|entity|resource|asset|object|thing|item|record|vertex|element|artifact|artefact)s?$", re.I)
#: Property keys that are names or identities, never a kind.
_IDENTITY_KEYS = frozenset({"urn", "id", "uuid", "name", "displayname", "qualifiedname", "description",
                            "title", "path", "fqn", "fullname", "key"})
#: Keys that read as "what kind of thing": ranked first, and the only ones
#: considered when the dominant type has a real name.
_KIND_KEY = re.compile(
    r"(^|[_\-.])(type|kind|category|class|classification|subtype|sub_type|node_?type|entity_?type|"
    r"object_?type|asset_?type|resource_?type|item_?type)$|^(type|kind|category|class|label|subtype)$", re.I)
_STRONG_KIND_KEYS = frozenset({"type", "kind", "category", "class", "subtype", "nodetype", "entitytype",
                               "objecttype", "assettype", "resourcetype", "itemtype", "classification"})
_WORDISH = re.compile(r"^[A-Za-z][\w\-./ ]{0,39}$")


def _norm(text: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


# ── The shape of a data source ──────────────────────────────────────────


def detect_type_property(catalog: Optional[dict], schema: Optional[dict],
                         introspection: Optional[dict]) -> list[dict]:
    """Properties that look like "what kind of thing each entity is", best
    first (at most 3) — only for a data source that keeps (almost)
    everything under one type. Never applied without the person's say-so."""
    if not isinstance(catalog, dict):
        return []
    view_types = sorted((t for t in catalog.get("entityTypes") or [] if isinstance(t, dict)),
                        key=lambda t: -int(t.get("count") or 0))
    total = int(catalog.get("entities") or sum(int(t.get("count") or 0) for t in view_types))
    if total < 20 or not view_types:
        return []
    dominant, t_count = str(view_types[0].get("type")), int(view_types[0].get("count") or 0)
    if t_count / total < 0.6:
        return []
    source_types = [r for r in (introspection or {}).get("entityTypeStats") or [] if int(r.get("count") or 0) > 0]
    populated = len(source_types) if source_types else len((schema or {}).get("entityTypes") or view_types)
    generic = bool(_GENERIC_TYPE.match(dominant))
    if not generic and populated > 2:
        return []
    found = []
    for prop in catalog.get("properties") or []:
        key = str(prop.get("key") or "")
        if not key or _norm(key) in _IDENTITY_KEYS:
            continue
        if not generic and _norm(key) not in _STRONG_KIND_KEYS:
            continue
        on_type = int((prop.get("byEntityType") or {}).get(dominant) or 0)
        if not t_count or on_type / t_count < 0.9:
            continue
        kinds = prop.get("kinds") or {}
        kinds_total = sum(int(v or 0) for v in kinds.values()) or int(prop.get("count") or 0)
        if not kinds_total or int(kinds.get("String") or 0) / kinds_total < 0.95:
            continue
        distinct = int(prop.get("distinct") or 0)
        values = [v for v in prop.get("values") or [] if isinstance(v, dict)]
        if not prop.get("distinctExact") or not 2 <= distinct <= 60 or not values:
            continue
        held = sum(int(v.get("count") or 0) for v in values) or 1
        if max(int(v.get("count") or 0) for v in values) / held > 0.97:
            continue
        wordish = sum(int(v.get("count") or 0) for v in values
                      if isinstance(v.get("value"), str) and _WORDISH.match(v["value"])
                      and len(v["value"].split()) <= 3) / held
        if wordish < 0.8:
            continue
        coverage = on_type / t_count
        found.append({
            "key": key, "on": dominant, "coverage": round(coverage, 3), "distinct": distinct,
            "values": [{"value": v.get("value"), "count": int(v.get("count") or 0)}
                       for v in sorted(values, key=lambda v: -int(v.get("count") or 0))[:50]],
            "_score": 2 * bool(_KIND_KEY.search(key)) + coverage + wordish - distinct / 60,
        })
    found.sort(key=lambda c: -c["_score"])
    for c in found:
        c.pop("_score")
    return found[:3]


def caveats(g) -> list[dict]:
    """What limits the answers here, in plain words."""
    out: list[dict] = []
    meta = (g.schema or {}).get("_meta") or {}
    if meta.get("status") == "computing":
        out.append({"code": "schema_computing",
                    "text": "This data source's schema is still being worked out, so some types and "
                            "counts may be missing."})
    elif meta.get("status") == "partial" or meta.get("source") == "ontology":
        out.append({"code": "schema_partial",
                    "text": "These are the semantic layer's types; counts arrive once the data source "
                            "has been profiled."})
    if g.type_candidates and not g.type_property:
        c = g.type_candidates[0]
        total = g.type_counts().get(c["on"]) or sum(v["count"] for v in c["values"])
        kinds = " · ".join(f"{v['value']} {v['count']:,}" for v in c["values"][:4])
        out.append({"code": "few_types", "action": "confirm_type",
                    "text": f"Everything here is a ‘{c['on']}’ ({total:,}). What kind of thing each one "
                            f"is looks like it's recorded in “{c['key']}”: {kinds}."})
    if g.schema is not None and (g.schema.get("entityTypes") or g.schema.get("relationshipTypes")):
        if not g.containment_edge_types:
            out.append({"code": "no_containment",
                        "text": "Nothing here is recorded as containing anything else, so there is no "
                                "hierarchy: questions about what's inside what can't be answered."})
        if not g.lineage_edge_types:
            out.append({"code": "no_lineage",
                        "text": "No connection is recorded as lineage, so questions about what feeds "
                                "what can't be answered."})
        other = [r for r in g.schema.get("relationshipTypes") or [] if r.get("class") == "other"]
        if other:
            names = ", ".join(str(r.get("name") or r.get("id")) for r in other[:4])
            out.append({"code": "unclassified_edges",
                        "text": f"{len(other)} kind{'s' if len(other) != 1 else ''} of connection ({names}) "
                                "are neither hierarchy nor lineage, so traces don't follow them."})
    if g.semantic_layer is not None and not g.semantic_layer.get("id"):
        out.append({"code": "lineage_by_default",
                    "text": "No semantic layer is assigned to this data source, so every connection is "
                            "read as lineage and nothing as hierarchy. An administrator can assign one "
                            "under Semantic layers."})
    if g.target.view_only:
        out.append({"code": "view_only",
                    "text": "You're reading this view through a share, so searches stay inside it and "
                            "can't follow lineage past its edge. Traces still can."})
    return out


def hierarchy_chains(schema: Optional[dict], limit: int = 3) -> list[list[str]]:
    """Up to *limit* of the longest top-to-bottom paths through the types'
    containment, e.g. ``["platform", "schema", "table", "column"]``."""
    if not schema:
        return []
    children: dict[str, set[str]] = {}
    for et in schema.get("entityTypes") or []:
        for child in et.get("canContain") or []:
            children.setdefault(str(et["id"]), set()).add(str(child))
    for rel in schema.get("relationshipTypes") or []:
        if rel.get("class") == "containment":
            for parent in rel.get("from") or []:
                for child in rel.get("to") or []:
                    if parent != child:
                        children.setdefault(str(parent), set()).add(str(child))
    if not children:
        return []
    contained = {c for kids in children.values() for c in kids}
    roots = [t for t in children if t not in contained] or sorted(children)[:1]
    chains: list[list[str]] = []

    def walk(path: list[str]) -> None:
        kids = sorted(children.get(path[-1], set()) - set(path))
        if not kids or len(path) >= 8:
            chains.append(path)
            return
        for kid in kids[:6]:
            walk(path + [kid])

    for root in sorted(roots)[:6]:
        walk([root])
    chains = [c for c in chains if len(c) >= 2]
    chains.sort(key=lambda c: (-len(c), c))
    picked: list[list[str]] = []
    for chain in chains:
        if not any(chain == p[:len(chain)] for p in picked):
            picked.append(chain)
        if len(picked) >= limit:
            break
    return picked


# ── For the person ──────────────────────────────────────────────────────


def _types(g, schema: Optional[dict]) -> list[dict]:
    in_view, in_source = g.type_counts(), g.source_counts()
    rows: dict[str, dict] = {}
    containment = [r for r in (schema or {}).get("relationshipTypes") or [] if r.get("class") == "containment"]
    for et in (schema or {}).get("entityTypes") or []:
        tid = str(et.get("id"))
        contains = set(et.get("canContain") or []) | {t for r in containment if tid in (r.get("from") or [])
                                                      for t in r.get("to") or [] if t != tid}
        contained_by = set(et.get("canBeContainedBy") or []) | {t for r in containment if tid in (r.get("to") or [])
                                                               for t in r.get("from") or [] if t != tid}
        rows[tid] = {"id": tid, "name": et.get("name") or tid, "plural": et.get("plural"),
                     "description": et.get("description"), "level": et.get("level"),
                     "inView": in_view.get(tid), "inSource": in_source.get(tid),
                     "contains": sorted(contains), "containedBy": sorted(contained_by),
                     "root": bool(et.get("isRoot"))}
    for tid in list(in_view) + list(in_source):
        rows.setdefault(tid, {"id": tid, "name": tid, "plural": None, "description": None, "level": None,
                              "inView": in_view.get(tid), "inSource": in_source.get(tid),
                              "contains": [], "containedBy": [], "root": False})
    ranked = sorted(rows.values(), key=lambda r: (-(r["inView"] if r["inView"] is not None else -1),
                                                  r["level"] if isinstance(r["level"], (int, float)) else 99,
                                                  -(r["inSource"] or 0), r["name"]))
    return ranked[:200]


def _connections(g, schema: Optional[dict]) -> list[dict]:
    counts = g.edge_counts()
    rows = {str(r.get("id")): {"id": str(r.get("id")), "name": r.get("name") or r.get("id"),
                               "class": r.get("class") or "other", "category": r.get("category"),
                               "description": r.get("description"), "from": list(r.get("from") or []),
                               "to": list(r.get("to") or []), "count": counts.get(str(r.get("id")))}
            for r in (schema or {}).get("relationshipTypes") or []}
    lineage, containment = set(g.lineage_edge_types), set(g.containment_edge_types)
    for edge_id, count in counts.items():
        rows.setdefault(edge_id, {"id": edge_id, "name": edge_id,
                                  "class": "containment" if edge_id in containment
                                  else "lineage" if edge_id in lineage else "other",
                                  "category": None, "description": None, "from": [], "to": [],
                                  "count": count})
    order = {"containment": 0, "lineage": 1, "other": 2}
    return sorted(rows.values(), key=lambda r: (-(r["count"] or 0), order.get(r["class"], 3), str(r["name"])))[:200]


def _type_property(g) -> Optional[dict]:
    if g.type_property:
        key = g.type_property.get("key")
        return {"status": "confirmed", "on": g.type_property.get("on"), "key": key,
                "values": list(g.value_sets.get(key) or [])[:50], "alternatives": []}
    if g.type_candidates:
        first, rest = g.type_candidates[0], g.type_candidates[1:]
        return {"status": "suggested", "on": first["on"], "key": first["key"], "values": first["values"][:50],
                "alternatives": [{"key": c["key"], "coverage": c["coverage"], "distinct": c["distinct"]}
                                 for c in rest]}
    return None


def _contents(g) -> Optional[dict]:
    if not g.catalog:
        return None
    entities = g.catalog.get("entities") or 0
    return {
        "entities": entities, "complete": g.catalog_complete,
        "properties": [{"key": p.get("key"), "count": p.get("count"),
                        "coverage": round(int(p.get("count") or 0) / entities, 3) if entities else None,
                        "kinds": list(p.get("kinds") or [])}
                       for p in g.properties()[:60]],
        "propertiesNotShown": g.catalog.get("propertiesNotShown") or 0,
        "tags": [{"tag": t.get("tag"), "count": t.get("count")} for t in g.tags()[:40]],
    }


def _view_about(g) -> dict:
    view, t = g.view or {}, g.target
    return {
        "name": view.get("name") or t.view_name or "This view",
        "description": view.get("description"),
        "workspace": view.get("workspace") or t.workspace_name,
        "dataSource": view.get("dataSource") or t.data_source_name,
        "semanticLayer": (g.semantic_layer or {}).get("name"),
        "template": view.get("template"), "layout": view.get("layout"),
        "tags": list(view.get("tags") or []), "owner": view.get("owner"),
        "updatedAt": view.get("updatedAt"), "dataUpdatedAt": view.get("dataUpdatedAt"),
        "visibility": view.get("visibility"),
        "viewId": t.view_id, "workspaceId": t.workspace_id, "dataSourceId": t.data_source_id,
    }


def _scope(view: Optional[dict]) -> Optional[dict]:
    scope = (view or {}).get("scope") or {}
    if not (scope.get("entityScope") or scope.get("visibleTypes") or scope.get("maxDepth") or scope.get("roots")):
        return None
    return scope


def _structure(g, schema: Optional[dict]) -> dict:
    chains = hierarchy_chains(schema)
    return {
        "types": _types(g, schema),
        "hierarchy": {"chains": chains} if chains else None,
        "connections": _connections(g, schema),
    }


def for_ui(g) -> dict:
    """The full card: everything the person may read about where they are."""
    page = g.page or {}
    kind = page.get("kind")
    if kind == "workspace":
        return {"kind": "workspace", "caveats": [], "notes": list(g.notes),
                "about": {"name": page.get("name") or page.get("title") or "This workspace",
                          "description": page.get("description"), "workspaceId": page.get("workspaceId")},
                "dataSources": [{"id": d.get("id"), "name": d.get("name"), "semanticLayer": None}
                                for d in page.get("dataSources") or []]}
    if kind == "ontology":
        onto = page.get("ontology") or {}
        return {"kind": "ontology", "caveats": [], "notes": list(g.notes),
                "about": {"name": page.get("name") or page.get("title") or "This semantic layer",
                          "description": page.get("description")},
                **_structure(_OntologyCounts(g), onto), "usedBy": page.get("usedBy") or []}
    if kind == "doc":
        return {"kind": "doc", "caveats": [], "notes": [],
                "about": {"name": page.get("title") or "This page"}, "headings": page.get("headings") or []}
    if not g.target.view_id:
        if kind in ("data_source", "explorer"):
            return {"kind": kind, "notes": list(g.notes),
                    "about": {"name": page.get("name") or page.get("title") or "This data source",
                              "description": page.get("description")},
                    "caveats": [{"code": "no_views",
                                 "text": "No view of this data source is open to you, so there is "
                                         "nothing to read through yet."}]}
        return {"kind": "app", "caveats": [], "notes": list(g.notes),
                "about": {"name": "Everything you can access"},
                "dataSources": [{"id": d.get("id"), "name": f"{w.get('workspace')} › {d.get('name')}",
                                 "semanticLayer": None}
                                for w in g.sources for d in w.get("dataSources") or []][:40]}
    out = {
        "kind": kind if kind in ("data_source", "explorer") else "view",
        "about": _view_about(g),
        "scope": _scope(g.view),
        "layers": list((g.view or {}).get("layers") or []),
        **_structure(g, g.schema),
        "contents": _contents(g),
        "typeProperty": _type_property(g),
        "caveats": caveats(g),
        "notes": list(g.notes),
        "seenThrough": page.get("seenThrough"),
    }
    if kind in ("data_source", "explorer"):
        out["about"] = {**out["about"], "name": page.get("name") or out["about"]["name"],
                        "description": page.get("description") or out["about"]["description"]}
    return out


class _OntologyCounts:
    """An ontology page has definitions but no data of its own to count."""

    def __init__(self, g):
        self._g = g
        onto = (g.page or {}).get("ontology") or {}
        self.lineage_edge_types = onto.get("lineageEdgeTypes") or []
        self.containment_edge_types = onto.get("containmentEdgeTypes") or []

    def type_counts(self) -> dict:
        return {}

    def source_counts(self) -> dict:
        return {}

    def edge_counts(self) -> dict:
        return {}


# ── For the model ───────────────────────────────────────────────────────


def _short(text: Any, n: int) -> Optional[str]:
    text = str(text or "").strip()
    return (text[: n - 1] + "…" if len(text) > n else text) or None


def for_model(g) -> dict:
    """The structure, ranked and bounded; descriptions and sample values
    under the keys the data-sharing policy strips."""
    brief = for_ui(g)
    card: dict[str, Any] = {}
    about = brief.get("about") or {}
    if brief["kind"] in ("view", "data_source", "explorer"):
        card["currentView"] = {k: v for k, v in {
            "viewId": about.get("viewId"), "name": about.get("name"),
            "workspaceId": about.get("workspaceId"), "dataSourceId": about.get("dataSourceId"),
            "workspace": about.get("workspace"), "dataSource": about.get("dataSource"),
            "semanticLayer": about.get("semanticLayer"), "layout": about.get("layout"),
            "description": _short(about.get("description"), 300), "tags": about.get("tags") or None,
        }.items() if v}
        if brief.get("seenThrough"):
            card["page"] = {"kind": brief["kind"], "seenThrough": brief["seenThrough"]["name"]}
    elif brief["kind"] in ("workspace", "ontology", "doc"):
        card["page"] = {k: v for k, v in {
            "kind": brief["kind"], "name": about.get("name"),
            "description": _short(about.get("description"), 300),
            "dataSources": [d["name"] for d in brief.get("dataSources") or []] or None,
            "usedBy": brief.get("usedBy") or None, "headings": brief.get("headings") or None,
        }.items() if v}
    if brief.get("layers"):
        card["layers"] = [{"name": l["name"], "types": l["types"], "description": _short(l.get("description"), 160)}
                          for l in brief["layers"][:12]]
    if brief.get("types"):
        card["entityTypes"] = [{k: v for k, v in {
            "id": t["id"], "name": t["name"] if t["name"] != t["id"] else None, "level": t["level"],
            "inView": t["inView"], "inSource": t["inSource"], "contains": t["contains"] or None,
            "description": _short(t["description"], 160)}.items() if v is not None}
            for t in brief["types"]]
    if brief.get("hierarchy"):
        card["hierarchy"] = [" › ".join(chain) for chain in brief["hierarchy"]["chains"]]
    if brief.get("connections"):
        card["relationships"] = [{k: v for k, v in {
            "id": r["id"], "class": r["class"], "category": r["category"], "from": r["from"] or None,
            "to": r["to"] or None, "count": r["count"], "description": _short(r["description"], 160)}.items()
            if v is not None} for r in brief["connections"]]
        card["containmentEdges"] = [r["id"] for r in brief["connections"] if r["class"] == "containment"]
        card["lineageEdges"] = [r["id"] for r in brief["connections"] if r["class"] == "lineage"]
    tp = brief.get("typeProperty")
    if tp and tp["status"] == "confirmed":
        # Confirmed kinds are the data source's type names now, like entity type ids.
        card["typeProperty"] = {"status": "confirmed", "on": tp["on"], "key": tp["key"],
                                "types": [v["value"] for v in tp["values"]]}
    elif tp:
        card["typeProperty"] = {"status": "suggested", "on": tp["on"], "key": tp["key"],
                                "values": tp["values"][:20]}
    if brief.get("caveats"):
        card["caveats"] = [c["text"] for c in brief["caveats"]][:6]
    return card


def fit(card: dict, policy, limit: int = 16_000) -> str:
    """*card* as model text within *limit* characters, shedding the least
    useful detail first instead of cutting the JSON mid-structure."""
    text = policy.to_model_text(card, limit=10 ** 9)
    if len(text) <= limit:
        return text
    card = copy.deepcopy(card)

    def drop_values():
        for prop in card.get("properties") or []:
            if isinstance(prop, dict):
                prop.pop("values", None)
        if isinstance(card.get("typeProperty"), dict):
            card["typeProperty"].pop("values", None)

    def drop_late_descriptions():
        for key in ("entityTypes", "relationships", "layers"):
            for row in (card.get(key) or [])[8:]:
                if isinstance(row, dict):
                    row.pop("description", None)

    def fewer(key: str, n: int):
        def shed():
            if isinstance(card.get(key), list) and len(card[key]) > n:
                card[key] = card[key][:n]
        return shed

    for shed in (drop_values, drop_late_descriptions, fewer("properties", 30), fewer("tags", 15),
                 fewer("entityTypes", 20), fewer("relationships", 20), fewer("selected", 4)):
        shed()
        text = policy.to_model_text(card, limit=10 ** 9)
        if len(text) <= limit:
            return text
    return policy.to_model_text(card, limit=limit)


def section(brief: dict, name: Optional[str], offset: int = 0, size: int = 25) -> Any:
    """One section of the card, a page at a time, for ``describe_context``."""
    if not name:
        return None
    value = brief.get(name)
    if isinstance(value, list):
        return {"items": value[offset:offset + size], "total": len(value), "offset": offset}
    return value


def summary(brief: dict) -> str:
    """One line for the conversation history."""
    about = brief.get("about") or {}
    bits = [f"{len(brief.get('types') or [])} types", f"{len(brief.get('connections') or [])} kinds of connection"]
    if brief.get("layers"):
        bits.insert(0, f"{len(brief['layers'])} layers")
    return f"[context card: {about.get('name')} — {', '.join(bits)}]"
