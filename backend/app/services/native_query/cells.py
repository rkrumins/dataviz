"""A native query's values, as the browser gets them — the same shapes from
either engine.

A plain string, number, true/false or null stays itself. Anything else is an
object with a ``kind``:

* ``node`` — ``id``, ``labels``, ``urn``, ``displayName``, ``properties``;
* ``edge`` — ``id``, ``type``, ``start`` and ``end`` (node ids), ``properties``;
* ``path`` — ``nodes`` and ``edges``, in order;
* ``map`` (``entries``), ``list`` (``items``);
* ``temporal`` (``type``, ISO ``text``), ``point`` (``srid``, ``coordinates``),
  ``bytes`` (``length``);
* ``number`` (``text``) — an integer JavaScript can't hold exactly, or NaN
  and the infinities, which JSON can't;
* ``string`` — text longer than ``MAX_TEXT``, cut (``text``, ``length``);
* ``truncated`` — nested deeper than ``MAX_DEPTH``.

Every list, map, property bag and path is cut at a fixed size and says so
(``truncated``), so one huge value can't make the answer huge. An edge's (or
node's) ``properties`` JSON blob, how this product stores an edge's own
properties, is read into a map.
"""
from __future__ import annotations

import json
import math
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from typing import Any, Iterable, List, Optional, Tuple

try:                                                      # the drivers are requirements;
    from falkordb import Edge as _FalkorEdge              # the import guard keeps this
    from falkordb import Node as _FalkorNode              # module usable without one
    from falkordb import Path as _FalkorPath
except ImportError:                                       # pragma: no cover
    _FalkorEdge = _FalkorNode = _FalkorPath = ()
try:
    from neo4j.graph import Node as _Neo4jNode
    from neo4j.graph import Path as _Neo4jPath
    from neo4j.graph import Relationship as _Neo4jRelationship
except ImportError:                                       # pragma: no cover
    _Neo4jNode = _Neo4jPath = _Neo4jRelationship = ()

MAX_TEXT = 2_000
MAX_ITEMS = 100
MAX_DEPTH = 4
MAX_STEPS = 100
_SAFE_INT = 2 ** 53 - 1


def to_cell(value: Any, depth: int = 0) -> Any:
    """``value`` — from either engine's client — as a cell."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if -_SAFE_INT <= value <= _SAFE_INT else {"kind": "number", "text": str(value)}
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        text = "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
        return {"kind": "number", "text": text}
    if isinstance(value, str):
        if len(value) <= MAX_TEXT:
            return value
        return {"kind": "string", "text": value[:MAX_TEXT], "length": len(value), "truncated": True}
    if depth >= MAX_DEPTH:
        return {"kind": "truncated"}
    if isinstance(value, (_FalkorNode, _Neo4jNode)):
        return _node(value, depth)
    if isinstance(value, (_FalkorEdge, _Neo4jRelationship)):
        return _edge(value, depth)
    if isinstance(value, (_FalkorPath, _Neo4jPath)):
        return _path(value, depth)
    temporal = _temporal(value)
    if temporal is not None:
        return temporal
    if isinstance(value, tuple) and hasattr(value, "srid"):
        return {"kind": "point", "srid": value.srid, "coordinates": [float(c) for c in value]}
    if isinstance(value, (bytes, bytearray)):
        return {"kind": "bytes", "length": len(value)}
    if isinstance(value, Mapping):
        return {"kind": "map", **_entries(value.items(), len(value), depth)}
    if isinstance(value, (list, tuple)):
        items = [to_cell(v, depth + 1) for v in value[:MAX_ITEMS]]
        return {"kind": "list", "items": items, **_cut(len(value), MAX_ITEMS)}
    return to_cell(str(value), depth)


def _node(node: Any, depth: int) -> dict:
    if isinstance(node, _FalkorNode):
        node_id, labels, props = node.id, node.labels or [], node.properties or {}
    else:
        node_id, labels, props = node.element_id, sorted(node.labels), dict(node.items())
    name = props.get("displayName") or props.get("name")
    return {
        "kind": "node",
        "id": str(node_id),
        "labels": list(labels),
        "urn": props.get("urn") if isinstance(props.get("urn"), str) else None,
        "displayName": name if isinstance(name, str) else None,
        **_properties(props, depth),
    }


def _edge(edge: Any, depth: int) -> dict:
    if isinstance(edge, _FalkorEdge):
        edge_id, kind, props = edge.id, edge.relation, edge.properties or {}
        start, end = _falkor_end(edge.src_node), _falkor_end(edge.dest_node)
    else:
        edge_id, kind, props = edge.element_id, edge.type, dict(edge.items())
        start, end = edge.start_node.element_id, edge.end_node.element_id
    return {
        "kind": "edge",
        "id": str(edge_id),
        "type": kind,
        "start": str(start),
        "end": str(end),
        **_properties(props, depth),
    }


def _falkor_end(end: Any) -> Any:
    """An edge's end as FalkorDB gives it: a node id, or the node."""
    return end.id if isinstance(end, _FalkorNode) else end


def _path(path: Any, depth: int) -> dict:
    if isinstance(path, _FalkorPath):
        nodes, edges = path.nodes(), path.edges()
    else:
        nodes, edges = list(path.nodes), list(path.relationships)
    return {
        "kind": "path",
        "nodes": [_node(n, depth + 1) for n in nodes[:MAX_STEPS + 1]],
        "edges": [_edge(e, depth + 1) for e in edges[:MAX_STEPS]],
        **_cut(len(edges), MAX_STEPS),
    }


def _properties(props: dict, depth: int) -> dict:
    bag = dict(props)
    blob = bag.get("properties")
    if isinstance(blob, str):
        try:
            decoded = json.loads(blob)
        except ValueError:
            decoded = None
        if isinstance(decoded, dict):
            bag["properties"] = decoded
    entries = _entries(bag.items(), len(bag), depth)
    return {"properties": entries["entries"], **({"truncated": True} if "truncated" in entries else {})}


def _entries(items: Iterable[Tuple[Any, Any]], size: int, depth: int) -> dict:
    out = {}
    for key, value in items:
        if len(out) == MAX_ITEMS:
            break
        out[str(key)] = to_cell(value, depth + 1)
    return {"entries": out, **_cut(size, MAX_ITEMS)}


def _cut(size: int, cap: int) -> dict:
    return {"truncated": True, "size": size} if size > cap else {}


def _temporal(value: Any) -> Optional[dict]:
    if hasattr(value, "iso_format"):                      # neo4j.time.*
        return {"kind": "temporal", "type": type(value).__name__.lower(), "text": value.iso_format()}
    for kind, cls in (("datetime", datetime), ("date", date), ("time", time)):
        if isinstance(value, cls):
            return {"kind": "temporal", "type": kind, "text": value.isoformat()}
    if isinstance(value, timedelta):
        return {"kind": "temporal", "type": "duration", "text": f"PT{value.total_seconds():g}S"}
    if type(value).__name__ == "relativedelta":           # FalkorDB's durations
        return {"kind": "temporal", "type": "duration", "text": _iso_duration(value)}
    return None


def _iso_duration(delta: Any) -> str:
    fields: List[str] = []
    for amount, unit in ((delta.years, "Y"), (delta.months, "M"), (delta.days, "D")):
        if amount:
            fields.append(f"{amount}{unit}")
    clock = [f"{amount}{unit}" for amount, unit in (
        (delta.hours, "H"), (delta.minutes, "M"), (delta.seconds, "S")) if amount]
    text = "P" + "".join(fields) + ("T" + "".join(clock) if clock else "")
    return text if text != "P" else "PT0S"
