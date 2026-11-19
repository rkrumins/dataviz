"""A change list as CSV: one row per change, or one per changed field and property.

Pure — the rows a change list export streams (``GET …/diff/export.csv``) are built here from
the change index's entries and, for the property-by-property export, each entity's value before
and after. Fields are named as the app names them (Name, Type, Description, …; a property by its
name, with its folder), bookkeeping is left out, and every cell is defused against spreadsheet
formula injection: a value an import or an edit wrote must never run as a formula when the file
is opened.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

CHANGE_COLUMNS = ["Kind", "Change", "Type", "Name", "Qualified name", "URN", "Entity id", "From", "To"]
FIELD_COLUMNS = CHANGE_COLUMNS + ["Field", "Folder", "Before", "After"]

_KIND = {"node": "Entity", "edge": "Relationship", "structure": "Structure"}
_STATUS = {"added": "Added", "modified": "Edited", "removed": "Removed"}

# A field by what it reads as, and the keys it is stored under — in reading order.
_NODE_FIELDS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("Name", ("displayName",)), ("Type", ("entityType",)), ("Description", ("description",)),
    ("Qualified name", ("qualifiedName",)), ("Source system", ("sourceSystem",)),
    ("Tags", ("tags",)), ("Layer", ("layerAssignment",)),
)
_EDGE_FIELDS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("Relationship", ("edgeType", "edge_type")),
    ("From", ("sourceEntityId", "source_entity_id", "source")),
    ("To", ("targetEntityId", "target_entity_id", "target")),
    ("Confidence", ("confidence",)),
)
_PROPERTY_LABEL = {"businessLabel": "Business label"}
# Bookkeeping, not content: never a row.
_NOISE = frozenset({
    "id", "urn", "entityId", "entity_id", "kind", "version", "discriminator", "childCount",
    "lastSyncedAt", "searchableText", "level", "levelDigest", "gvHash", "urnSource", "nameSource",
    "propertiesRaw", "createdAt", "updatedAt", "created_at", "updated_at", "properties",
})
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def cell(value: Any) -> str:
    """A value as a CSV cell: text as is, lists joined, objects as JSON — and never a formula."""
    if value is None:
        return ""
    if isinstance(value, bool):
        text = "Yes" if value else "No"
    elif isinstance(value, (list, tuple)) and all(isinstance(v, (str, int, float)) for v in value):
        text = "; ".join(str(v) for v in value)
    elif isinstance(value, (dict, list, tuple)):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    else:
        text = str(value)
    return f"'{text}" if text.startswith(_FORMULA_START) else text


def _empty(v: Any) -> bool:
    return v is None or v == "" or (isinstance(v, (list, tuple)) and len(v) == 0)


def _same(a: Any, b: Any) -> bool:
    if (_empty(a) and _empty(b)) or a == b:
        return True
    try:
        return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return False


def _property_name(key: str) -> Tuple[str, str]:
    cut = key.rfind("/")
    return _PROPERTY_LABEL.get(key, key[cut + 1:] if cut >= 0 else key), (key[:cut] if cut >= 0 else "")


def field_changes(before: Optional[Mapping[str, Any]], after: Optional[Mapping[str, Any]],
                  kind: str) -> List[Tuple[str, str, Any, Any]]:
    """What changed on one entity — ``(field, folder, before, after)`` — its named fields first,
    then each property that changed, by folder and name. A side missing (an entity added or
    removed) lists every field the other side has."""
    b, a = dict(before or {}), dict(after or {})
    fields = _EDGE_FIELDS if kind == "edge" else _NODE_FIELDS
    known = {k for _, keys in fields for k in keys}
    out: List[Tuple[str, str, Any, Any]] = []
    for label, keys in fields:
        bv = next((b[k] for k in keys if k in b), None)
        av = next((a[k] for k in keys if k in a), None)
        if not _same(bv, av):
            out.append((label, "", bv, av))
    bp = b.get("properties") if isinstance(b.get("properties"), dict) else {}
    ap = a.get("properties") if isinstance(a.get("properties"), dict) else {}
    props: List[Tuple[str, str, Any, Any]] = []
    for key in sorted(set(bp) | set(ap)):
        if key.startswith("_") or _same(bp.get(key), ap.get(key)):
            continue
        name, folder = _property_name(key)
        props.append((name, folder, bp.get(key), ap.get(key)))
    # Anything else at the top level: a legacy flattened edge's properties, or an unnamed field.
    for key in sorted(set(b) | set(a)):
        if key in known or key in _NOISE or key.startswith("_") or key in bp or key in ap:
            continue
        if kind == "edge" and key == "type":
            continue
        if _same(b.get(key), a.get(key)):
            continue
        name, folder = _property_name(key)
        props.append((name, folder, b.get(key), a.get(key)))
    props.sort(key=lambda r: (r[1], r[0]))
    return out + props


def change_row(entry: Mapping[str, Any]) -> List[str]:
    """One change as the export's leading columns (``entry`` as ``entry_dict`` makes it)."""
    edge = entry.get("kind") == "edge"
    return [cell(v) for v in (
        _KIND.get(str(entry.get("kind")), entry.get("kind")),
        _STATUS.get(str(entry.get("status")), entry.get("status")),
        entry.get("type"),
        None if edge else entry.get("displayName"),
        None if edge else entry.get("qualifiedName"),
        None if edge else entry.get("urn"),
        entry.get("entityId"),
        (entry.get("sourceName") or entry.get("sourceEntityId")) if edge else None,
        (entry.get("targetName") or entry.get("targetEntityId")) if edge else None,
    )]


def field_rows(entry: Mapping[str, Any], before: Optional[Mapping[str, Any]],
               after: Optional[Mapping[str, Any]]) -> Iterable[List[str]]:
    """One change, one row per field or property it changed (one row, with no field, when it
    changed none the export names)."""
    lead = change_row(entry)
    kind = "edge" if entry.get("kind") == "edge" else "node"
    changes = field_changes(before, after, kind)
    if not changes:
        yield lead + ["", "", "", ""]
        return
    for name, folder, b, a in changes:
        yield lead + [cell(name), cell(folder), cell(b), cell(a)]


def filename(origin: Dict[str, Any], detail: str) -> str:
    """``changes-draft-br_1.csv`` / ``changes-r41-r42-properties.csv``."""
    what = (f"draft-{origin['branch_id']}" if origin.get("branch_id")
            else f"r{origin.get('from_seq')}-r{origin.get('to_seq')}")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in what)
    return f"changes-{safe}{'-properties' if detail == 'properties' else ''}.csv"


# --------------------------------------------------------------------------- #
# A change at a glance: what a change list row says before it is opened       #
# --------------------------------------------------------------------------- #
_NAMED = frozenset(label for label, _keys in _NODE_FIELDS + _EDGE_FIELDS)
_KIND_RANK = {"changed": 0, "added": 1, "removed": 2}
_CLIP_TEXT = 160
_CLIP_ITEMS = 12


def _kind(before: Any, after: Any) -> str:
    return "added" if _empty(before) else "removed" if _empty(after) else "changed"


def _clip(value: Any) -> Tuple[Any, bool]:
    """A value short enough to send with every row of a page: text to 160 characters, a list to 12
    items, an object as compact JSON of 160 characters. Whether it was cut."""
    if isinstance(value, str):
        return (value, False) if len(value) <= _CLIP_TEXT else (value[:_CLIP_TEXT - 1] + "…", True)
    if isinstance(value, (list, tuple)):
        items = list(value)
        cut = len(items) > _CLIP_ITEMS
        return [(_clip(v)[0] if isinstance(v, str) else v) for v in items[:_CLIP_ITEMS]], cut
    if isinstance(value, dict):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
        return (value, False) if len(text) <= _CLIP_TEXT else (text[:_CLIP_TEXT - 1] + "…", True)
    return value, False


def field_summary(before: Optional[Mapping[str, Any]], after: Optional[Mapping[str, Any]], kind: str,
                  top: int = 5) -> Dict[str, Any]:
    """What one change did, counted, with its first few fields — the named ones in reading order
    (Name, Type, Description…), then properties edited, added, removed — each with its two values,
    clipped. The frontend's ``keyDifferences`` orders them the same way (a shared fixture checks)."""
    rows = [(label, folder, b, a, _kind(b, a)) for label, folder, b, a in field_changes(before, after, kind)]
    named = [r for r in rows if not r[1] and r[0] in _NAMED]
    rest = sorted((r for r in rows if not (not r[1] and r[0] in _NAMED)), key=lambda r: _KIND_RANK[r[4]])
    counts = {"changed": 0, "added": 0, "removed": 0}
    for r in rows:
        counts[r[4]] += 1
    out = []
    for label, folder, b, a, k in (named + rest)[:top]:
        bv, bcut = _clip(b)
        av, acut = _clip(a)
        item: Dict[str, Any] = {"label": label, "folder": folder or None, "kind": k, "before": bv, "after": av}
        if bcut or acut:
            item["clipped"] = True
        out.append(item)
    return {**counts, "total": len(rows), "top": out}
